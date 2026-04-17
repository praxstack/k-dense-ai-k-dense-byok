import logging
import os

from dotenv import load_dotenv
from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from .mcps import all_mcps
from .manifest import close_turn, open_turn

from .tools.gemini_cli import delegate_task
from .utils import (
    format_skills_reference,
    list_skill_summaries,
    load_instructions,
)

load_dotenv()

DEFAULT_MODEL = os.getenv("DEFAULT_AGENT_MODEL")
EXTRA_HEADERS = {"X-Title": "Kady", "HTTP-Referer": "https://www.k-dense.ai"}
PARALLEL_API_KEY = os.getenv("PARALLEL_API_KEY")

logger = logging.getLogger(__name__)


def _build_instruction() -> str:
    base = load_instructions("main_agent")
    skills = list_skill_summaries()
    return base + format_skills_reference(skills)


def _override_model(callback_context, llm_request):
    override = callback_context.state.get("_model")
    if override:
        llm_request.model = override
    return None


def _extract_text(content) -> str:
    if content is None:
        return ""
    parts = getattr(content, "parts", None) or []
    chunks = []
    for part in parts:
        text = getattr(part, "text", None)
        if text:
            chunks.append(text)
    return "".join(chunks)


async def _open_turn_manifest(callback_context):
    """Mint a turn id and write the initial manifest for reproducibility."""
    try:
        ctx = callback_context._invocation_context
        session = ctx.session
        user_text = _extract_text(ctx.user_content)
        state = callback_context.state

        model = state.get("_model") or DEFAULT_MODEL
        skills = state.get("_skills") or []
        databases = state.get("_databases") or []
        compute = state.get("_compute")
        attachments = state.get("_attachments") or []

        turn_id, _manifest = await open_turn(
            session_id=session.id,
            user_text=user_text,
            attachments=attachments,
            model=model,
            skills=skills,
            databases=databases,
            compute=compute,
        )
        state["_turnId"] = turn_id
        state["_sessionId"] = session.id
    except Exception as exc:
        logger.warning("Failed to open turn manifest: %s", exc)
    return None


async def _close_turn_manifest(callback_context):
    """Finalize the manifest after the agent produces its final output."""
    try:
        state = callback_context.state
        turn_id = state.get("_turnId")
        session_id = state.get("_sessionId")
        if not turn_id or not session_id:
            return None
        assistant_text = state.get("final_output") or ""
        if not isinstance(assistant_text, str):
            assistant_text = str(assistant_text)
        await close_turn(
            session_id=session_id,
            turn_id=turn_id,
            assistant_text=assistant_text,
        )
    except Exception as exc:
        logger.warning("Failed to close turn manifest: %s", exc)
    return None


root_agent = LlmAgent(
    name="MainAgent",
    model=LiteLlm(
        model=DEFAULT_MODEL,
        extra_headers=EXTRA_HEADERS,
    ),
    description="The main agent that makes sure the user's request is successfully fulfilled",
    instruction=_build_instruction(),
    tools=[delegate_task] + all_mcps,
    output_key="final_output",
    before_model_callback=_override_model,
    before_agent_callback=_open_turn_manifest,
    after_agent_callback=_close_turn_manifest,
)
