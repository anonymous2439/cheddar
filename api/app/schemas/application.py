from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ApplicationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    key_description: str | None = Field(default=None, max_length=255, description="Where this key will be used")


class ApplicationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    status: str
    created_at: datetime


class ApplicationCreateResponse(BaseModel):
    application: ApplicationOut
    api_key: str = Field(description="Full API key — shown only once, store it securely")
    key_prefix: str
    key_description: str | None = None


class ApiKeyCreate(BaseModel):
    description: str | None = Field(default=None, max_length=255, description="Where this key will be used")


class ApiKeyCreateResponse(BaseModel):
    api_key: str = Field(description="Full API key — shown only once, store it securely")
    key_prefix: str
    description: str | None = None
