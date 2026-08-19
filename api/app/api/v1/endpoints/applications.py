from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.security import generate_opaque_token
from app.db.session import get_db
from app.models.api_key import ApiKey
from app.models.application import Application
from app.schemas.application import ApplicationCreate, ApplicationCreateResponse

router = APIRouter()


@router.post("", response_model=ApplicationCreateResponse, status_code=201)
def create_application(payload: ApplicationCreate, db: Session = Depends(get_db)):
    application = Application(name=payload.name, description=payload.description)
    db.add(application)
    db.flush()

    raw_key, key_prefix, key_hash = generate_opaque_token(prefix="ched_")
    api_key = ApiKey(application_id=application.id, key_prefix=key_prefix, key_hash=key_hash)
    db.add(api_key)
    db.commit()
    db.refresh(application)

    return ApplicationCreateResponse(application=application, api_key=raw_key, key_prefix=key_prefix)
