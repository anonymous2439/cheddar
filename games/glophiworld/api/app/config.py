from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    # Must match Cheddar's own JWT_SECRET_KEY (api/.env) — this service has
    # no login of its own, same pattern as karirs'/Luba's/glsimsworld's own
    # security.py.
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    # The Luba lobby handoff (see main.py's own luba_start handler) calls
    # this directly, server-to-server, to configure a match's duration
    # before any client connects — matches games/luba/api/run.py's own port.
    luba_api_base_url: str = "http://127.0.0.1:8013"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
