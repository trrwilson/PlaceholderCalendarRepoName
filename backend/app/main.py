import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import router
from app.config import get_settings

# uvicorn's own logging config (see uvicorn.config.LOGGING_CONFIG) sets up the
# "uvicorn" / "uvicorn.access" loggers but never touches the root logger, so
# without this every app.* `logger.info(...)` call in the codebase (display
# probes, presence detection, …) is silently dropped — the console shows
# uvicorn's own request lines but none of the application's. `basicConfig` is
# a no-op if the root logger already has a handler, so this is safe regardless
# of import order relative to uvicorn's setup.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

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

    # Presence: the aggregator itself is pure/free and built lazily on first
    # use. Bind the event loop unconditionally while presence is enabled — the
    # display-dim policy's on_signal hook needs it to bridge in from the
    # camera's background thread / a sync request handler thread, neither of
    # which run on it (see app/presence/display_policy.py). The camera thread
    # and the dim policy's countdown are each started only when their own gate
    # is also open (docs/camera-support-plan.md, docs/display-dimming-plan.md).
    if get_settings().presence_enabled:
        from app.presence import bind_event_loop, start_display_dim_policy

        bind_event_loop()
        start_display_dim_policy()
    if get_settings().host_local_camera:
        from app.presence import start_local_camera

        start_local_camera()
    try:
        yield
    finally:
        await store.restore_full()
        if get_settings().host_local_camera:
            from app.presence import stop_local_camera

            stop_local_camera()
        if get_settings().presence_enabled:
            from app.presence import stop_display_dim_policy

            stop_display_dim_policy()


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
