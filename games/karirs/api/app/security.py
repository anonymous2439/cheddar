from fastapi import Header, HTTPException, status
from jose import JWTError, jwt

from app.config import settings


def decode_user_id(token: str | None) -> int | None:
    """Shared by the HTTP dependency below and the race websocket, which
    can't carry an Authorization header and takes the token as a query
    param instead. Returns None rather than raising, so callers can respond
    however fits their transport (HTTP 401 vs closing the socket)."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    if payload.get("type") != "access":
        return None
    try:
        return int(payload["sub"])
    except (KeyError, ValueError):
        return None


def get_current_user_id(authorization: str | None = Header(default=None)) -> int:
    """Trusts any token signed with Cheddar's own JWT secret — this service
    has no login of its own, it just verifies identity Cheddar already
    established."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")

    user_id = decode_user_id(authorization.split(" ", 1)[1])
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    return user_id
