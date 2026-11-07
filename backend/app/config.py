"""Application settings (env vars or .env file, prefix CQA_)."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CQA_", env_file=".env", extra="ignore")

    app_name: str = "Freedom Broker CQA Backend"
    database_url: str = "sqlite:///./cqa.db"
    # Run Alembic migrations + seed the default checklist on startup.
    auto_migrate: bool = True
    cors_origins: str = "*"  # comma-separated list, "*" = allow all

    # --- Organizer API -------------------------------------------------
    # Full GET URL of the organizers' endpoint WITHOUT the group_id parameter.
    # The guide does not publish the URL (it's behind the "Открыть GET для DEV" button),
    # so it must be configured. Leave empty to use mock mode.
    organizer_api_url: str = ""
    organizer_group_param: str = "group_id"
    organizer_dev_group_id: str = "DEV"
    # Announced by the organizers ~23h after start. Can also be passed in the request body.
    organizer_control_group_id: str = ""
    # Optional pagination support (the documented API has none — leave empty).
    organizer_page_param: str = ""
    organizer_page_size_param: str = ""
    organizer_page_size: int = 100
    organizer_timeout_seconds: float = 30.0
    organizer_max_retries: int = 3
    # "auto": real API if organizer_api_url is set, otherwise mock. "mock" / "live" force a mode.
    organizer_mode: str = "auto"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def organizer_use_mock(self) -> bool:
        if self.organizer_mode == "mock":
            return True
        if self.organizer_mode == "live":
            return False
        return not self.organizer_api_url


@lru_cache
def get_settings() -> Settings:
    return Settings()
