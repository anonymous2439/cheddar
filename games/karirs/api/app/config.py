from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    starting_coins: int = 500
    # Only needed to call back into Cheddar's own API (e.g. posting the
    # "watch the replay" system message once a race resolves) — Cheddar's
    # /games/* endpoints only require a valid bearer token, no API key, so
    # there's nothing else to configure here.
    cheddar_api_base_url: str = "http://127.0.0.1:8008"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
