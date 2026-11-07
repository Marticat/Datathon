"""FastAPI entrypoint: `uvicorn app.main:app --reload`."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.config import get_settings
from app.errors import install_error_handlers

log = logging.getLogger("cqa")


def init_database() -> None:
    """Apply Alembic migrations and seed the default checklist (no manual DB steps needed)."""
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    from app.database import SessionLocal
    from app.seed import seed_default_checklist

    root = Path(__file__).resolve().parent.parent
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", get_settings().database_url)
    command.upgrade(cfg, "head")
    with SessionLocal() as db:
        if seed_default_checklist(db):
            log.info("Seeded default checklist v1")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if get_settings().auto_migrate:
        init_database()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        description="Backend for Freedom Broker Conversation Quality Analytics. "
        "AI evaluation is a separate module that submits results to `POST /api/v1/evaluations/submit`; "
        "this service validates, stores and scores them deterministically. See docs/AI_INTEGRATION.md.",
        lifespan=lifespan,
    )
    origins = settings.cors_origin_list
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials="*" not in origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_error_handlers(app)
    app.include_router(router)

    @app.get("/health", tags=["meta"])
    def health():
        return {"status": "ok"}

    return app


app = create_app()
