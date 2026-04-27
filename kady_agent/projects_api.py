"""HTTP endpoints for project CRUD and sandbox (re)initialisation.

Mounted under the root path of the main FastAPI app in ``server.py``. The
middleware in ``server.py`` sets the active project for each request; the
endpoints here explicitly read and mutate the project registry, so they
bypass the usual ``active_paths()`` resolution and operate on whichever
project id is in the URL or request body.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from .cost_ledger import check_project_budget, read_project_costs
from .projects import (
    DEFAULT_PROJECT_ID,
    create_project,
    delete_project,
    ensure_project_exists,
    get_project,
    init_project_sandbox,
    list_projects,
    update_project,
)

logger = logging.getLogger(__name__)


def _bootstrap_sandbox_sync(project_id: str) -> None:
    """Run the lightweight, synchronous half of the sandbox bootstrap.

    Copies ``GEMINI.md``, writes merged MCP settings, seeds ``pyproject.toml``
    in the sandbox, and copies the scientific-skills catalogue from any
    sibling project that already has it. The GitHub fallback is suppressed
    here so POST /projects stays fast even when no sibling exists - the
    background task picks that case up.

    Doing this work synchronously protects against ``uvicorn --reload`` (or
    any other process restart) killing the background task before skills
    are seeded, which previously left ``sandbox/.gemini/skills`` empty for
    newly created projects.
    """
    try:
        init_project_sandbox(
            project_id,
            sync_venv=False,
            download_skills=True,
            allow_remote_skills=False,
        )
    except Exception:
        logger.exception(
            "Synchronous sandbox bootstrap failed for project %s", project_id
        )


def _bootstrap_sandbox_bg(
    project_id: str, *, sync_venv: bool = True, download_skills: bool = True
) -> None:
    """Run the heavy sandbox bootstrap, swallowing errors into the log.

    Executed via FastAPI ``BackgroundTasks`` so ``POST /projects`` can return
    the new project record immediately while ``uv sync`` and the GitHub
    skills fallback run out-of-band. Any exception is logged but never
    re-raised - the task has already detached from the request.
    """
    try:
        init_project_sandbox(
            project_id, sync_venv=sync_venv, download_skills=download_skills
        )
    except Exception:
        logger.exception("Sandbox bootstrap failed for project %s", project_id)


projects_router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectCreateBody(BaseModel):
    name: str
    description: Optional[str] = ""
    tags: Optional[list[str]] = Field(default_factory=list)
    id: Optional[str] = None  # let callers pin a slug, otherwise we mint one
    spendLimitUsd: Optional[float] = None


class ProjectPatchBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    archived: Optional[bool] = None
    # ``None`` means "clear the cap" (unlimited). We rely on Pydantic's
    # ``model_fields_set`` to distinguish "field omitted" from "field = null"
    # when forwarding the patch to update_project.
    spendLimitUsd: Optional[float] = None


class SandboxInitBody(BaseModel):
    sync_venv: bool = True
    download_skills: bool = True


@projects_router.get("")
def get_projects():
    """Return every known project (archived projects sorted last)."""
    return [m.to_dict() for m in list_projects()]


@projects_router.post("", status_code=201)
def post_project(body: ProjectCreateBody, background_tasks: BackgroundTasks):
    """Create a new project and schedule its sandbox bootstrap.

    Returns the project record immediately after writing the on-disk
    skeleton. The heavy bootstrap (GEMINI.md, merged ``.gemini/settings.json``,
    ``pyproject.toml``, ``uv sync``, scientific-skills catalogue) runs as a
    background task so the HTTP response isn't blocked on ``uv sync``.
    """
    try:
        meta = create_project(
            name=body.name,
            description=body.description or "",
            tags=body.tags or [],
            project_id=body.id,
            spend_limit_usd=body.spendLimitUsd,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Touch the on-disk skeleton so subsequent GET /sandbox/tree etc. work
    # without requiring an explicit init call.
    ensure_project_exists(meta.id)
    # Run the lightweight bootstrap (GEMINI.md, settings, pyproject, sibling
    # skill copy) inline so those artefacts are guaranteed to land before
    # the request returns. The slow ``uv sync`` (and the GitHub skill
    # fallback if no sibling existed) stays in the background task.
    _bootstrap_sandbox_sync(meta.id)
    background_tasks.add_task(_bootstrap_sandbox_bg, meta.id)
    return meta.to_dict()


@projects_router.get("/{project_id}")
def get_one_project(project_id: str):
    meta = get_project(project_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return meta.to_dict()


@projects_router.patch("/{project_id}")
def patch_project(project_id: str, body: ProjectPatchBody):
    # Pass through spendLimitUsd only if the caller actually included it in the
    # payload (vs Pydantic filling in the default None). update_project uses a
    # sentinel to distinguish "omit" from "clear to unlimited".
    kwargs: dict = {
        "name": body.name,
        "description": body.description,
        "tags": body.tags,
        "archived": body.archived,
    }
    if "spendLimitUsd" in body.model_fields_set:
        kwargs["spend_limit_usd"] = body.spendLimitUsd
    try:
        meta = update_project(project_id, **kwargs)
    except KeyError:
        raise HTTPException(status_code=404, detail="Project not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return meta.to_dict()


@projects_router.delete("/{project_id}", status_code=204)
def delete_one_project(project_id: str):
    if project_id == DEFAULT_PROJECT_ID:
        raise HTTPException(
            status_code=400, detail="The default project cannot be deleted"
        )
    meta = get_project(project_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        delete_project(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return None


@projects_router.get("/{project_id}/costs")
def get_project_cost_summary(project_id: str):
    """Return cumulative cost across every session in a project.

    Also echoes the project's current ``spendLimitUsd`` and a pre-classified
    budget ``state`` (ok / warn / exceeded) so the UI can render both the
    number and the progress bar in a single request.
    """
    meta = get_project(project_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Project not found")
    summary = read_project_costs(project_id)
    budget = check_project_budget(project_id, meta.spendLimitUsd)
    summary["limitUsd"] = meta.spendLimitUsd
    summary["budget"] = budget
    return summary


@projects_router.post("/{project_id}/sandbox/init")
def post_init_sandbox(project_id: str, body: SandboxInitBody | None = None):
    """Run (or re-run) the heavy sandbox bootstrap for a project.

    Creates GEMINI.md, merged ``.gemini/settings.json``, pyproject.toml,
    runs ``uv sync``, and downloads the scientific skills catalogue.
    Idempotent.
    """
    if get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    body = body or SandboxInitBody()
    init_project_sandbox(
        project_id,
        sync_venv=body.sync_venv,
        download_skills=body.download_skills,
    )
    return {"ok": True}
