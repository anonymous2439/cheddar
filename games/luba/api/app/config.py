from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Must match Cheddar's own JWT_SECRET_KEY (api/.env) — this service has
    # no login of its own, it only verifies identity Cheddar already
    # established, same pattern as karirs'/the old pokeworld's security.py.
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
