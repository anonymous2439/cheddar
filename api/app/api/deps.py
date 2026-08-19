from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.auth_service import resolve_application, resolve_user_from_access_token
from app.db.session import get_db
from app.models.application import Application
from app.models.user import User


def get_current_application(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    db: Session = Depends(get_db),
) -> Application:
    application = resolve_application(db, x_api_key)
    if application is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing API key")
    return application


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")

    token = authorization.split(" ", 1)[1]
    user = resolve_user_from_access_token(db, token)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")

    return user
