from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.friendship import Friendship
from app.models.user import User
from app.models.user_block import UserBlock
from app.schemas.friendship import BlockCreate, BlockOut
from app.schemas.user import UserOut

router = APIRouter()


@router.post("", response_model=BlockOut, status_code=201)
def block_user(
    payload: BlockCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if payload.user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot block yourself")

    target = db.get(User, payload.user_id)
    if target is None or target.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    existing = (
        db.query(UserBlock)
        .filter(UserBlock.blocker_id == user.id, UserBlock.blocked_id == target.id)
        .first()
    )
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "User already blocked")

    # blocking dissolves any existing friendship/pending request between the two
    friendship = (
        db.query(Friendship)
        .filter(
            or_(
                (Friendship.requester_id == user.id) & (Friendship.addressee_id == target.id),
                (Friendship.requester_id == target.id) & (Friendship.addressee_id == user.id),
            )
        )
        .first()
    )
    if friendship is not None:
        db.delete(friendship)

    block = UserBlock(blocker_id=user.id, blocked_id=target.id)
    db.add(block)
    db.commit()
    db.refresh(block)

    return BlockOut(user=UserOut.model_validate(target), created_at=block.created_at)


@router.get("", response_model=list[BlockOut])
def list_blocked_users(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(UserBlock).filter(UserBlock.blocker_id == user.id).all()
    blocked_ids = [row.blocked_id for row in rows]
    users_by_id = {u.id: u for u in db.query(User).filter(User.id.in_(blocked_ids)).all()} if blocked_ids else {}
    return [
        BlockOut(user=UserOut.model_validate(users_by_id[row.blocked_id]), created_at=row.created_at)
        for row in rows
        if row.blocked_id in users_by_id
    ]


@router.delete("/{user_id}", status_code=204)
def unblock_user(
    user_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        db.query(UserBlock)
        .filter(UserBlock.blocker_id == user.id, UserBlock.blocked_id == user_id)
        .first()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Block not found")

    db.delete(row)
    db.commit()
    return None
