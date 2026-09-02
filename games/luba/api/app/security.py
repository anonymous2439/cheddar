from fastapi import Header, HTTPException, status
from jose import JWTError, jwt

from app.config import settings


def decode_user_id(token: str | None) -> int | None:
    """The websocket can't carry an Authorization header, so it takes the
    token as a query param instead — this is shared by both, returning None
    rather than raising so the caller can respond however fits its own
    transport (HTTP 401 vs closing the socket)."""
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
    """FastAPI dependency for regular (non-websocket) endpoints — e.g.
    POST /matches, which sets a lobby's match config before anyone
    connects. Trusts any token signed with Cheddar's own JWT secret, same
    as decode_user_id above; this service has no login of its own."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")

    user_id = decode_user_id(authorization.split(" ", 1)[1])
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    return user_id
