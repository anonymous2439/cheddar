from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.friendship import Friendship
from app.models.user import User
from app.models.user_block import UserBlock
from app.schemas.friendship import FriendRequestCreate, FriendRequestOut
from app.schemas.user import UserOut

router = APIRouter()


def _other_user_id(row: Friendship, current_user_id: int) -> int:
    return row.addressee_id if row.requester_id == current_user_id else row.requester_id


def _get_friendship(db: Session, user_a: int, user_b: int) -> Friendship | None:
    return (
        db.query(Friendship)
        .filter(
            or_(
                (Friendship.requester_id == user_a) & (Friendship.addressee_id == user_b),
                (Friendship.requester_id == user_b) & (Friendship.addressee_id == user_a),
            )
        )
        .first()
    )


def _is_blocked(db: Session, user_a: int, user_b: int) -> bool:
    return (
        db.query(UserBlock)
        .filter(
            or_(
                (UserBlock.blocker_id == user_a) & (UserBlock.blocked_id == user_b),
                (UserBlock.blocker_id == user_b) & (UserBlock.blocked_id == user_a),
            )
        )
        .first()
        is not None
    )


def _to_request_out(row: Friendship, current_user_id: int, other_user: User) -> FriendRequestOut:
    direction = "outgoing" if row.requester_id == current_user_id else "incoming"
    return FriendRequestOut(
        id=row.id,
        status=row.status,
        direction=direction,
        user=UserOut.model_validate(other_user),
        created_at=row.created_at,
        responded_at=row.responded_at,
    )


@router.post("/requests", response_model=FriendRequestOut, status_code=201)
def send_friend_request(
    payload: FriendRequestCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if payload.user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot friend yourself")

    target = db.get(User, payload.user_id)
    if target is None or target.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    if _is_blocked(db, user.id, target.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Cannot send a friend request to this user")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    existing = _get_friendship(db, user.id, target.id)

    if existing is not None:
        if existing.status == "accepted":
            raise HTTPException(status.HTTP_409_CONFLICT, "Already friends")

        if existing.status == "pending":
            if existing.requester_id == user.id:
                raise HTTPException(status.HTTP_409_CONFLICT, "Friend request already sent")
            # the other user already requested us -> this action accepts it
            existing.status = "accepted"
            existing.responded_at = now
            db.commit()
            db.refresh(existing)
            return _to_request_out(existing, user.id, target)

        # declined -> allow a fresh request, reusing the row (unique constraint is per pair)
        existing.requester_id = user.id
        existing.addressee_id = target.id
        existing.status = "pending"
        existing.responded_at = None
        db.commit()
        db.refresh(existing)
        return _to_request_out(existing, user.id, target)

    friendship = Friendship(requester_id=user.id, addressee_id=target.id, status="pending")
    db.add(friendship)
    db.commit()
    db.refresh(friendship)
    return _to_request_out(friendship, user.id, target)


@router.get("/requests", response_model=list[FriendRequestOut])
def list_friend_requests(
    direction: str = "incoming",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if direction not in ("incoming", "outgoing"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "direction must be 'incoming' or 'outgoing'")

    column = Friendship.addressee_id if direction == "incoming" else Friendship.requester_id
    rows = db.query(Friendship).filter(Friendship.status == "pending", column == user.id).all()

    other_ids = [_other_user_id(row, user.id) for row in rows]
    users_by_id = {u.id: u for u in db.query(User).filter(User.id.in_(other_ids)).all()} if other_ids else {}

    return [_to_request_out(row, user.id, users_by_id[_other_user_id(row, user.id)]) for row in rows]


@router.post("/requests/{request_id}/accept", response_model=FriendRequestOut)
def accept_friend_request(
    request_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = db.get(Friendship, request_id)
    if row is None or row.addressee_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Friend request not found")
    if row.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Request is not pending")

    row.status = "accepted"
    row.responded_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(row)

    other = db.get(User, row.requester_id)
    return _to_request_out(row, user.id, other)


@router.post("/requests/{request_id}/decline", response_model=FriendRequestOut)
def decline_friend_request(
    request_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = db.get(Friendship, request_id)
    if row is None or row.addressee_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Friend request not found")
    if row.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Request is not pending")

    row.status = "declined"
    row.responded_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(row)

    other = db.get(User, row.requester_id)
    return _to_request_out(row, user.id, other)


@router.delete("/requests/{request_id}", status_code=204)
def cancel_friend_request(
    request_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = db.get(Friendship, request_id)
    if row is None or row.requester_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Friend request not found")
    if row.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Request is not pending")

    db.delete(row)
    db.commit()
    return None


@router.get("", response_model=list[UserOut])
def list_friends(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (
        db.query(Friendship)
        .filter(
            Friendship.status == "accepted",
            or_(Friendship.requester_id == user.id, Friendship.addressee_id == user.id),
        )
        .all()
    )
    friend_ids = [_other_user_id(row, user.id) for row in rows]
    if not friend_ids:
        return []
    return db.query(User).filter(User.id.in_(friend_ids)).all()


@router.delete("/{user_id}", status_code=204)
def remove_friend(
    user_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = _get_friendship(db, user.id, user_id)
    if row is None or row.status != "accepted":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Friendship not found")

    db.delete(row)
    db.commit()
    return None
