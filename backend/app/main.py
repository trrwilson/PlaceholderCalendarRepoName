import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import router
from app.config import get_settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # The physical-display effector only reaches the OS when this process asserts
    # it owns the attached panel; probe once so diagnostics record the live
    # mechanism (docs/display-dimming-plan.md). On shutdown always hand the panel
    # back at full brightness — a dimming feature must never leave the wall dim.
    from app.display import get_display_store

    store = get_display_store()
    if get_settings().host_local_display:
        import asyncio

        await asyncio.to_thread(store.probe)
    try:
        yield
    finally:
        await store.restore_full()


app = FastAPI(title="Mission Control API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        # the repo's .claude/launch.json dev port (Browser-pane preview)
        "http://localhost:5188",
        "http://127.0.0.1:5188",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
