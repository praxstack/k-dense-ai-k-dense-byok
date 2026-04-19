import logging
import os

import litellm
from dotenv import load_dotenv
from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from litellm.integrations.custom_logger import CustomLogger
from .cost_ledger import extract_cost_tags, record_cost
from .mcps import all_mcps
from .manifest import close_turn, open_turn
from . import projects

from .tools.gemini_cli import delegate_task
from .utils import (
    format_skills_reference,
    list_skill_summaries,
    load_instructions,
)

load_dotenv()

DEFAULT_MODEL = os.getenv("DEFAULT_AGENT_MODEL")
# Separate default for the Gemini CLI expert subprocess. The expert is a
# tool-heavy CLI agent, so we recommend Gemini 3.1 Pro (native tool calling +
# 1M-token context) rather than the orchestrator's Claude Opus default. Users
# can still override via DEFAULT_EXPERT_MODEL or per-turn from the UI.
DEFAULT_EXPERT_MODEL = (
    os.getenv("DEFAULT_EXPERT_MODEL")
    or "openrouter/google/gemini-3.1-pro-preview"
)
EXTRA_HEADERS = {"X-Title": "Kady", "HTTP-Referer": "https://www.k-dense.ai"}
PARALLEL_API_KEY = os.getenv("PARALLEL_API_KEY")

logger = logging.getLogger(__name__)


def _build_instruction() -> str:
    base = load_instructions("main_agent")
    skills = list_skill_summaries()
    return base + format_skills_reference(skills)


def _inject_tracking_headers(callback_context):
    """Stamp the orchestrator's LLM call with Kady correlation headers.

    OpenRouter ignores unknown ``X-*`` headers, so this is safe. The
    LiteLLM success callback reads these back out of ``optional_params
    .extra_headers`` to correlate cost entries with the right session/turn
    in ``costs.jsonl``.
    """
    state = callback_context.state
    merged = dict(EXTRA_HEADERS)
    merged["X-Kady-Role"] = "orchestrator"
    session_id = state.get("_sessionId")
    turn_id = state.get("_turnId")
    if session_id:
        merged["X-Kady-Session-Id"] = session_id
    if turn_id:
        merged["X-Kady-Turn-Id"] = turn_id
    try:
        project_id = projects.current_project_id()
    except LookupError:
        project_id = None
    if project_id:
        merged["X-Kady-Project"] = project_id

    # ``_additional_args`` is the LiteLlm-owned kwargs bag that gets
    # forwarded verbatim into ``litellm.acompletion``. Mutating it here
    # is safe because ADK serializes model calls per agent invocation.
    _LITELLM_MODEL._additional_args["extra_headers"] = merged

    # ``extra_headers`` is dropped from the LiteLLM success-callback
    # ``kwargs`` on some provider paths, so stash the same correlation IDs
    # in ``metadata`` -- LiteLLM forwards user-supplied metadata through
    # ``kwargs["litellm_params"]["metadata"]`` verbatim.
    existing_meta = _LITELLM_MODEL._additional_args.get("metadata")
    meta = dict(existing_meta) if isinstance(existing_meta, dict) else {}
    meta["kady_role"] = "orchestrator"
    if session_id:
        meta["kady_session_id"] = session_id
    if turn_id:
        meta["kady_turn_id"] = turn_id
    if project_id:
        meta["kady_project"] = project_id
    _LITELLM_MODEL._additional_args["metadata"] = meta

    # Ask OpenRouter to include native usage accounting (token counts +
    # dollar cost) in the streamed response. See:
    # https://openrouter.ai/docs/guides/administration/usage-accounting
    existing_extra_body = _LITELLM_MODEL._additional_args.get("extra_body")
    extra_body = dict(existing_extra_body) if isinstance(existing_extra_body, dict) else {}
    extra_body["usage"] = {"include": True}
    _LITELLM_MODEL._additional_args["extra_body"] = extra_body


def _override_model(callback_context, llm_request):
    override = callback_context.state.get("_model")
    if override:
        llm_request.model = override
    _inject_tracking_headers(callback_context)
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
        expert_model = (
            state.get("_expertModel")
            or state.get("_model")
            or DEFAULT_EXPERT_MODEL
        )
        skills = state.get("_skills") or []
        databases = state.get("_databases") or []
        compute = state.get("_compute")
        attachments = state.get("_attachments") or []

        turn_id, _manifest = await open_turn(
            session_id=session.id,
            user_text=user_text,
            attachments=attachments,
            model=model,
            expert_model=expert_model,
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


_LITELLM_MODEL = LiteLlm(
    model=DEFAULT_MODEL,
    extra_headers=EXTRA_HEADERS,
)

root_agent = LlmAgent(
    name="MainAgent",
    model=_LITELLM_MODEL,
    description="The main agent that makes sure the user's request is successfully fulfilled",
    instruction=_build_instruction(),
    tools=[delegate_task] + all_mcps,
    output_key="final_output",
    before_model_callback=_override_model,
    before_agent_callback=_open_turn_manifest,
    after_agent_callback=_close_turn_manifest,
)


class _OrchestratorCostLogger(CustomLogger):
    """LiteLLM callback that writes orchestrator cost entries.

    Runs inside the ADK/FastAPI process (i.e. every ``litellm.acompletion``
    call initiated by ``_LITELLM_MODEL``). We trust the ``X-Kady-*`` headers
    we stamped in ``_inject_tracking_headers`` to route the entry to the
    correct ``costs.jsonl``.
    """

    @staticmethod
    def _extract_tags_from_kwargs(kwargs: dict) -> dict | None:
        """Pull the X-Kady-* correlation IDs out of the callback kwargs.

        Prefers ``litellm_params.metadata`` (where we stash our tags) and
        falls back to the ``extra_headers`` carried on optional_params or
        litellm_params on provider paths that keep them.
        """
        lparams = kwargs.get("litellm_params") or {}
        meta = lparams.get("metadata") if isinstance(lparams, dict) else None
        if isinstance(meta, dict) and any(
            k.startswith("kady_") for k in meta.keys()
        ):
            return {
                "role": meta.get("kady_role"),
                "session_id": meta.get("kady_session_id"),
                "turn_id": meta.get("kady_turn_id"),
                "delegation_id": meta.get("kady_delegation_id"),
                "project_id": meta.get("kady_project"),
            }
        optional = kwargs.get("optional_params") or {}
        headers = optional.get("extra_headers") or (
            lparams.get("extra_headers") if isinstance(lparams, dict) else None
        )
        return extract_cost_tags(headers) if headers else None

    def _record(self, kwargs, response_obj):
        try:
            tags = self._extract_tags_from_kwargs(kwargs)
            if not tags or tags.get("role") != "orchestrator":
                return
            if not tags.get("session_id") or not tags.get("turn_id"):
                return
            provider = kwargs.get("custom_llm_provider")
            if provider != "openrouter":
                # Only OpenRouter provides native cost; skip Ollama/etc.
                return
            lparams = kwargs.get("litellm_params") or {}
            # LiteLLM strips the ``openrouter/`` prefix at logging time,
            # so pull the fully-qualified name back out of hidden params.
            model = kwargs.get("model")
            meta = lparams.get("metadata") if isinstance(lparams, dict) else None
            if isinstance(meta, dict):
                hidden = meta.get("hidden_params") or {}
                full = hidden.get("litellm_model_name")
                if isinstance(full, str) and full:
                    model = full
            usage = getattr(response_obj, "usage", None)
            if usage is None and isinstance(response_obj, dict):
                usage = response_obj.get("usage")
            # Prefer OpenRouter's native cost (pennies-exact) when available,
            # falling back to LiteLLM's pricing-table estimate.
            cost = None
            for attr in ("cost", "total_cost"):
                candidate = getattr(usage, attr, None)
                if candidate is None and isinstance(usage, dict):
                    candidate = usage.get(attr)
                if candidate is not None:
                    cost = candidate
                    break
            if cost is None:
                cost = kwargs.get("response_cost")
            logger.warning(
                "[cost-cb] cost extract; response_cost=%s usage_type=%s usage=%s",
                kwargs.get("response_cost"),
                type(usage).__name__,
                usage if isinstance(usage, dict) else vars(usage) if hasattr(usage, "__dict__") else usage,
            )
            record_cost(
                session_id=tags["session_id"],
                turn_id=tags["turn_id"],
                role="orchestrator",
                model=model,
                usage_dict=usage,
                cost_usd=cost,
                delegation_id=tags.get("delegation_id"),
                project_id=tags.get("project_id"),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Orchestrator cost callback failed: %s", exc)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._record(kwargs, response_obj)

    async def async_log_success_event(
        self, kwargs, response_obj, start_time, end_time
    ):
        self._record(kwargs, response_obj)


_orchestrator_cost_logger = _OrchestratorCostLogger()
# Register on both sync and async pathways. Use append rather than assignment
# so we don't clobber any callbacks ADK or third-party code may have set up.
if _orchestrator_cost_logger not in litellm.callbacks:
    litellm.callbacks.append(_orchestrator_cost_logger)
