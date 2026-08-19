from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.user import UserOut

router = APIRouter()


@router.get("/search", response_model=list[UserOut])
def search_users(
    q: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if len(q) < 2:
        return []

    return (
        db.query(User)
        .filter(User.username.like(f"%{q}%"), User.id != user.id, User.deleted_at.is_(None))
        .limit(20)
        .all()
    )
