"""Request-scoped ADK session service that writes to per-project SQLite DBs.

Each project owns its own ``sessions.db`` under ``projects/<id>/sessions.db``.
The active project id is tracked via the ``ACTIVE_PROJECT`` ContextVar (set
by the FastAPI middleware in ``server.py``). Every call into this service
reads the ContextVar, lazily instantiates a per-project
``DatabaseSessionService`` on first use, caches it for reuse, and delegates.

A single instance of this wrapper is installed on the ADK
``AdkWebServer.session_service`` attribute. Because ADK's runners capture
the *reference* to the session service (not a snapshot of its state), every
runner call transparently routes to the right DB based on the current
request's ContextVar value.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from google.adk.events.event import Event
from google.adk.sessions.base_session_service import (
    BaseSessionService,
    GetSessionConfig,
    ListSessionsResponse,
)
from google.adk.sessions.database_session_service import DatabaseSessionService
from google.adk.sessions.session import Session

from .projects import ensure_project_exists, current_project_id


class ProjectSessionService(BaseSessionService):
    """Fan out ADK session calls to per-project DatabaseSessionService instances."""

    def __init__(self) -> None:
        self._services: dict[str, DatabaseSessionService] = {}
        self._lock = asyncio.Lock()

    async def _service_for(self, project_id: str) -> DatabaseSessionService:
        svc = self._services.get(project_id)
        if svc is not None:
            return svc
        async with self._lock:
            svc = self._services.get(project_id)
            if svc is not None:
                return svc
            paths = ensure_project_exists(project_id)
            # ADK's DatabaseSessionService uses SQLAlchemy's async engine, so
            # the URL needs an async-capable driver. Plain `sqlite://` loads
            # the sync `pysqlite` driver which raises
            # `InvalidRequestError: The asyncio extension requires an async
            # driver`. `sqlite+aiosqlite://` routes to the aiosqlite driver
            # (already pulled in transitively via google-adk).
            db_url = f"sqlite+aiosqlite:///{paths.sessions_db_path}"
            svc = DatabaseSessionService(db_url)
            self._services[project_id] = svc
            return svc

    async def _active(self) -> DatabaseSessionService:
        return await self._service_for(current_project_id())

    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: Optional[dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> Session:
        svc = await self._active()
        return await svc.create_session(
            app_name=app_name,
            user_id=user_id,
            state=state,
            session_id=session_id,
        )

    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: Optional[GetSessionConfig] = None,
    ) -> Optional[Session]:
        svc = await self._active()
        return await svc.get_session(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            config=config,
        )

    async def list_sessions(
        self, *, app_name: str, user_id: Optional[str] = None
    ) -> ListSessionsResponse:
        svc = await self._active()
        return await svc.list_sessions(app_name=app_name, user_id=user_id)

    async def delete_session(
        self, *, app_name: str, user_id: str, session_id: str
    ) -> None:
        svc = await self._active()
        await svc.delete_session(
            app_name=app_name, user_id=user_id, session_id=session_id
        )

    async def append_event(self, session: Session, event: Event) -> Event:
        svc = await self._active()
        return await svc.append_event(session, event)
