from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.security import decode_access_token, hash_token
from app.models.api_key import ApiKey
from app.models.application import Application
from app.models.user import User


def resolve_application(db: Session, raw_api_key: str | None) -> Application | None:
    if not raw_api_key:
        return None

    key_hash = hash_token(raw_api_key)
    api_key = db.query(ApiKey).filter(ApiKey.key_hash == key_hash).first()
    if api_key is None or api_key.revoked_at is not None:
        return None

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if api_key.expires_at is not None and api_key.expires_at < now:
        return None

    application = db.get(Application, api_key.application_id)
    if application is None or application.status != "active":
        return None

    api_key.last_used_at = now
    db.commit()

    return application


def resolve_user_from_access_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None

    payload = decode_access_token(token)
    if payload is None or payload.get("type") != "access":
        return None

    user = db.get(User, int(payload["sub"]))
    if user is None or user.deleted_at is not None:
        return None

    return user
