from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_application, get_current_user
from app.core.config import settings
from app.core.security import (
    create_access_token,
    generate_opaque_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.db.session import get_db
from app.models.application import Application
from app.models.refresh_token import RefreshToken
from app.models.user import User
from app.schemas.auth import LoginRequest, RefreshRequest, TokenResponse
from app.schemas.user import UserCreate, UserOut

router = APIRouter()


def _issue_tokens(db: Session, user: User, application: Application) -> TokenResponse:
    raw_refresh, _, refresh_hash = generate_opaque_token()
    expires_at = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=settings.refresh_token_expire_days)

    db.add(
        RefreshToken(
            user_id=user.id,
            application_id=application.id,
            token_hash=refresh_hash,
            expires_at=expires_at,
        )
    )
    db.commit()

    access_token = create_access_token(user_id=user.id, application_id=application.id)
    return TokenResponse(
        access_token=access_token,
        refresh_token=raw_refresh,
        expires_in=settings.access_token_expire_minutes * 60,
    )


@router.post("/register", response_model=UserOut, status_code=201)
def register(
    payload: UserCreate,
    db: Session = Depends(get_db),
    application: Application = Depends(get_current_application),
):
    existing = (
        db.query(User)
        .filter(or_(User.username == payload.username, User.email == payload.email))
        .first()
    )
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Username or email already in use")

    user = User(
        username=payload.username,
        email=payload.email,
        password_hash=hash_password(payload.password),
        display_name=payload.display_name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse)
def login(
    payload: LoginRequest,
    db: Session = Depends(get_db),
    application: Application = Depends(get_current_application),
):
    user = (
        db.query(User)
        .filter(or_(User.username == payload.identifier, User.email == payload.identifier))
        .filter(User.deleted_at.is_(None))
        .first()
    )
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

    return _issue_tokens(db, user, application)


@router.post("/refresh", response_model=TokenResponse)
def refresh(
    payload: RefreshRequest,
    db: Session = Depends(get_db),
    application: Application = Depends(get_current_application),
):
    token_hash = hash_token(payload.refresh_token)
    stored = (
        db.query(RefreshToken)
        .filter(RefreshToken.token_hash == token_hash, RefreshToken.application_id == application.id)
        .first()
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if stored is None or stored.revoked_at is not None or stored.expires_at < now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired refresh token")

    user = db.get(User, stored.user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")

    stored.revoked_at = now
    db.commit()

    return _issue_tokens(db, user, application)


@router.post("/logout", status_code=204)
def logout(
    payload: RefreshRequest,
    db: Session = Depends(get_db),
    application: Application = Depends(get_current_application),
):
    token_hash = hash_token(payload.refresh_token)
    stored = (
        db.query(RefreshToken)
        .filter(RefreshToken.token_hash == token_hash, RefreshToken.application_id == application.id)
        .first()
    )
    if stored is not None and stored.revoked_at is None:
        stored.revoked_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
    return None


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user
