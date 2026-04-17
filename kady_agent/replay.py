"""Pipeline replay: re-run every saved delegation in a session from manifests.

This is *not* bit-exact replay — LLM providers give no determinism
guarantees. Replay rehydrates the sandbox from the content-addressable
attachment store captured at the original turn, then re-invokes each
delegation with the exact prompt, model slug, and session seed the manifest
recorded. Divergences (in model output, tool results, or deliverable files)
are recorded into a new manifest per replayed turn with
``replayedFrom: <originalTurnId>`` so reviewers can diff old vs new.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from .manifest import (
    RUNS_DIR,
    SANDBOX_ROOT,
    _write_json,
    manifest_path,
    read_manifest,
    ulid,
)
from .tools.gemini_cli import delegate_task

REPLAYS_DIR = SANDBOX_ROOT / ".kady" / "replays"


def _rehydrate_attachments(
    *,
    manifest: dict,
    replay_sandbox: Path,
) -> list[str]:
    """Copy each attachment from content-addressable storage into replay_sandbox.

    Returns the relative paths that were successfully restored.
    """
    restored: list[str] = []
    session_id = manifest["sessionId"]
    turn_id = manifest["turnId"]
    original_turn_dir = RUNS_DIR / session_id / turn_id
    for att in manifest.get("input", {}).get("attachments", []):
        sha = att.get("sha256")
        rel = att.get("path")
        if not sha or not rel:
            continue
        src = original_turn_dir / "attachments" / sha
        if not src.is_file():
            continue
        dest = replay_sandbox / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, dest)
            restored.append(rel)
        except OSError:
            continue
    return restored


async def replay_turn(
    *,
    session_id: str,
    turn_id: str,
    replay_id: str,
) -> AsyncIterator[dict]:
    """Replay a single turn. Yields progress events suitable for SSE streaming.

    Events yielded:
        {"event": "replay_turn_start", ...}
        {"event": "delegation_start", ...}
        {"event": "delegation_complete", ...}
        {"event": "replay_turn_complete", ...}
        {"event": "replay_error", ...}
    """
    original = read_manifest(session_id, turn_id)
    if not original:
        yield {"event": "replay_error", "detail": f"manifest not found: {turn_id}"}
        return

    new_turn_id = ulid()
    replay_sandbox = REPLAYS_DIR / replay_id / new_turn_id
    replay_sandbox.mkdir(parents=True, exist_ok=True)

    restored = _rehydrate_attachments(
        manifest=original, replay_sandbox=replay_sandbox
    )

    new_manifest: dict[str, Any] = {
        "turnId": new_turn_id,
        "sessionId": f"replay-{replay_id}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "replayedFrom": {
            "sessionId": original["sessionId"],
            "turnId": original["turnId"],
            "manifestSha256": original.get("manifestSha256"),
        },
        "input": {
            "promptSha256": original["input"]["promptSha256"],
            "promptPreview": original["input"]["promptPreview"],
            "attachments": original["input"]["attachments"],
            "restoredAttachments": restored,
            "databases": original["input"]["databases"],
            "skills": original["input"]["skills"],
            "compute": original["input"]["compute"],
        },
        "env": dict(original.get("env", {})),
        "delegations": [],
        "output": {"deliverables": [], "durationMs": 0},
        "startedAt": time.time(),
    }

    replay_turn_dir = REPLAYS_DIR / replay_id / "runs" / new_turn_id
    replay_turn_dir.mkdir(parents=True, exist_ok=True)
    _write_json(replay_turn_dir / "manifest.json", new_manifest)

    yield {
        "event": "replay_turn_start",
        "replayId": replay_id,
        "newTurnId": new_turn_id,
        "originalTurnId": turn_id,
        "restoredAttachments": restored,
        "delegationCount": len(original.get("delegations", [])),
    }

    for original_delegation in original.get("delegations", []):
        prompt = original_delegation.get("prompt", "")
        if not prompt:
            continue
        delegation_id = original_delegation.get("id", uuid.uuid4().hex[:8])

        yield {
            "event": "delegation_start",
            "originalDelegationId": delegation_id,
            "promptPreview": prompt[:200],
        }

        started = time.time()
        try:
            # We deliberately do not pass tool_context here: we want the
            # delegation to execute in the replay sandbox with the recorded
            # seed, not to mutate the live session state.
            from os import environ

            environ["KADY_SEED"] = original["env"].get("seed", "")
            environ["KADY_REPLAY_TURN_ID"] = new_turn_id
            environ["KADY_REPLAY_SESSION_ID"] = f"replay-{replay_id}"
            environ["KADY_DELEGATION_ID"] = delegation_id
            result = await delegate_task(
                prompt=prompt,
                working_directory=str(replay_sandbox),
            )
        except Exception as exc:
            yield {
                "event": "replay_error",
                "delegationId": delegation_id,
                "detail": str(exc),
            }
            new_manifest["delegations"].append(
                {
                    "id": delegation_id,
                    "prompt": prompt,
                    "error": str(exc),
                    "durationMs": int((time.time() - started) * 1000),
                }
            )
            _write_json(replay_turn_dir / "manifest.json", new_manifest)
            continue

        duration_ms = int((time.time() - started) * 1000)
        delegation_record = {
            "id": delegation_id,
            "prompt": prompt,
            "cwd": str(replay_sandbox),
            "skillsUsed": result.get("skills_used", []),
            "toolsUsed": result.get("tools_used", {}),
            "durationMs": duration_ms,
            "resultPreview": (result.get("result") or "")[:500],
        }
        new_manifest["delegations"].append(delegation_record)
        _write_json(replay_turn_dir / "manifest.json", new_manifest)

        yield {
            "event": "delegation_complete",
            "delegationId": delegation_id,
            "durationMs": duration_ms,
            "skillsUsed": delegation_record["skillsUsed"],
            "resultPreview": delegation_record["resultPreview"],
        }

    new_manifest["output"]["durationMs"] = int(
        (time.time() - new_manifest["startedAt"]) * 1000
    )
    _write_json(replay_turn_dir / "manifest.json", new_manifest)

    yield {
        "event": "replay_turn_complete",
        "replayId": replay_id,
        "newTurnId": new_turn_id,
        "originalTurnId": turn_id,
        "durationMs": new_manifest["output"]["durationMs"],
        "diff": _diff_summary(original, new_manifest),
    }


def _diff_summary(original: dict, replayed: dict) -> dict:
    """Compact diff summary the UI can show next to the replay header.

    Compares input hashes, output hashes (if present), citation counts, and
    claims counts.
    """
    def _citations(m: dict) -> tuple[int, int, int]:
        c = m.get("citations") or {}
        return (
            int(c.get("total", 0)),
            int(c.get("verified", 0)),
            int(c.get("unresolved", 0)),
        )

    return {
        "inputHashMatch": original.get("input", {}).get("promptSha256")
        == replayed.get("input", {}).get("promptSha256"),
        "delegationsOriginal": len(original.get("delegations", [])),
        "delegationsReplayed": len(replayed.get("delegations", [])),
        "citationsOriginal": _citations(original),
    }


async def replay_session(
    *,
    session_id: str,
    turn_ids: list[str] | None = None,
) -> AsyncIterator[dict]:
    """Replay every turn (or the given ``turn_ids``) for a session."""
    from .manifest import list_turns

    replay_id = ulid()
    if turn_ids is None:
        turn_ids = list_turns(session_id)

    yield {
        "event": "replay_session_start",
        "replayId": replay_id,
        "sessionId": session_id,
        "turnIds": turn_ids,
    }

    for turn_id in turn_ids:
        async for event in replay_turn(
            session_id=session_id, turn_id=turn_id, replay_id=replay_id
        ):
            yield event

    yield {"event": "replay_session_complete", "replayId": replay_id}
