from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    identifier: str = Field(description="Username or email")
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
