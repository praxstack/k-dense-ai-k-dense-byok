import asyncio
import json
import os
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from google.adk.tools.tool_context import ToolContext

from ..manifest import (
    RUNS_DIR,
    attach_delegation,
    session_seed,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

load_dotenv(REPO_ROOT / "kady_agent" / ".env")

_VERTEX_AI_ENV_VARS = ("GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS")

# OpenRouter "App" label (via LiteLLM proxy). Format: gemini-cli-core GEMINI_CLI_CUSTOM_HEADERS.
_CLI_OPENROUTER_HEADERS = (
    "X-Title: Kady-Expert, HTTP-Referer: https://www.k-dense.ai"
)


def _parse_stream_json(raw: str) -> dict:
    """Parse Gemini CLI stream-json (JSONL) output into a structured result.

    Extracts the final response text, activated skills, and tools used from
    the JSONL event stream so callers get richer metadata than the plain JSON
    format provides.
    """
    response_parts: list[str] = []
    skills_used: list[str] = []
    tools_used: dict[str, int] = {}

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = event.get("type")

        if etype == "tool_use":
            tool_name = event.get("tool_name", "")
            tools_used[tool_name] = tools_used.get(tool_name, 0) + 1

            if tool_name == "activate_skill":
                params = event.get("parameters") or {}
                skill = (
                    params.get("skill_name")
                    or params.get("name")
                    or next((v for v in params.values() if isinstance(v, str)), "")
                )
                if skill and skill not in skills_used:
                    skills_used.append(skill)

        elif etype == "message" and event.get("role") == "assistant":
            content = event.get("content", "")
            if content:
                response_parts.append(content)

    return {
        "result": "".join(response_parts),
        "skills_used": skills_used,
        "tools_used": tools_used,
    }


def _collect_expert_artifacts(kady_dir: Path, delegation_id: str) -> tuple[str | None, list[str] | None]:
    """Read expert-side env.lock and deliverables.json written by the Gemini CLI.

    The expert is instructed (see instructions/gemini_cli.md PROTOCOL:REPRODUCIBILITY)
    to write `.kady/expert/<delegationId>/env.lock` and `deliverables.json`. We
    read and return them so they can be persisted into the manifest.
    """
    expert_dir = kady_dir / "expert" / delegation_id
    env_lock: str | None = None
    deliverables: list[str] | None = None
    try:
        env_path = expert_dir / "env.lock"
        if env_path.is_file():
            env_lock = env_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        pass
    try:
        deliv_path = expert_dir / "deliverables.json"
        if deliv_path.is_file():
            data = json.loads(deliv_path.read_text(encoding="utf-8", errors="replace"))
            if isinstance(data, list):
                deliverables = [str(item) for item in data if isinstance(item, (str, int))]
    except (OSError, json.JSONDecodeError):
        pass
    return env_lock, deliverables


async def delegate_task(
    prompt: str,
    working_directory: str = "sandbox",
    tool_context: Optional[ToolContext] = None,
) -> dict:
    """Delegate a task to an expert.

    Args:
        prompt: The prompt to delegate to the expert.
        working_directory: The sandbox directory to execute the task in.

    Returns:
        A dict with ``result`` (response text), ``skills_used`` (list of
        activated Gemini CLI skill names), and ``tools_used`` (tool call
        counts).
    """
    env = os.environ.copy()
    for var in _VERTEX_AI_ENV_VARS:
        env.pop(var, None)

    prev_headers = env.get("GEMINI_CLI_CUSTOM_HEADERS", "").strip()
    env["GEMINI_CLI_CUSTOM_HEADERS"] = (
        f"{prev_headers}, {_CLI_OPENROUTER_HEADERS}"
        if prev_headers
        else _CLI_OPENROUTER_HEADERS
    )

    cwd = Path(working_directory)
    if not cwd.is_absolute():
        cwd = REPO_ROOT / cwd

    cwd.mkdir(parents=True, exist_ok=True)

    # Reproducibility: stamp turn + delegation identifiers into the env so the
    # expert can name its env.lock / deliverables.json files correctly, and
    # seed every RNG it controls from KADY_SEED.
    state = tool_context.state if tool_context is not None else None
    turn_id: Optional[str] = None
    session_id: Optional[str] = None
    delegation_id: Optional[str] = None
    if state is not None:
        turn_id = state.get("_turnId")
        session_id = state.get("_sessionId")
    if session_id and turn_id:
        env["KADY_SEED"] = session_seed(session_id)
        env["KADY_TURN_ID"] = turn_id
        env["KADY_SESSION_ID"] = session_id
        # Delegation id is monotonic within a turn to keep paths predictable.
        counter_key = f"_delegation_counter_{turn_id}"
        prev = state.get(counter_key) or 0
        delegation_id = f"{int(prev) + 1:03d}"
        state[counter_key] = int(prev) + 1
        env["KADY_DELEGATION_ID"] = delegation_id

    sandbox_venv = cwd / ".venv"
    if sandbox_venv.is_dir():
        venv_bin = str(sandbox_venv / "bin")
        env["VIRTUAL_ENV"] = str(sandbox_venv)
        path_parts = env.get("PATH", "").split(os.pathsep)
        old_venv = os.environ.get("VIRTUAL_ENV")
        if old_venv:
            old_bin = os.path.join(old_venv, "bin")
            path_parts = [p for p in path_parts if p != old_bin]
        env["PATH"] = os.pathsep.join([venv_bin] + path_parts)

    started_at = time.time()
    proc = await asyncio.create_subprocess_exec(
        "gemini",
        "-p",
        prompt,
        "--yolo",
        "--output-format",
        "stream-json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    stdout_bytes, stderr_bytes = await proc.communicate()
    duration_ms = int((time.time() - started_at) * 1000)

    if proc.returncode != 0:
        raise RuntimeError(
            stderr_bytes.decode(errors="replace").strip() or "gemini command failed"
        )

    raw = stdout_bytes.decode(errors="replace")
    result = _parse_stream_json(raw)

    # Persist delegation into the manifest (best-effort).
    if session_id and turn_id and delegation_id:
        env_lock: str | None = None
        deliverables: list[str] | None = None
        kady_dir = cwd / ".kady"
        if kady_dir.is_dir():
            env_lock, deliverables = _collect_expert_artifacts(kady_dir, delegation_id)
        try:
            # Also mirror the delegation dir into the run-level manifest tree so
            # the expert's stdout is reachable by turnId (not just by cwd).
            target_expert_dir = RUNS_DIR / session_id / turn_id / "expert" / delegation_id
            target_expert_dir.mkdir(parents=True, exist_ok=True)
            await attach_delegation(
                session_id=session_id,
                turn_id=turn_id,
                delegation_id=delegation_id,
                prompt=prompt,
                cwd=str(cwd.relative_to(REPO_ROOT)) if cwd.is_relative_to(REPO_ROOT) else str(cwd),
                result=result,
                duration_ms=duration_ms,
                stdout=raw,
                env_lock=env_lock,
                deliverables=deliverables,
            )
        except Exception:
            pass

    return result


if __name__ == "__main__":
    result = asyncio.run(delegate_task("What is the capital of France?"))
    print(result)
