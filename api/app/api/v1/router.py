from fastapi import APIRouter

from app.api.v1.endpoints import applications, auth, beats, blocks, chess, conversations, friends, games, mtg, users

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(applications.router, prefix="/applications", tags=["applications"])
api_router.include_router(conversations.router, prefix="/conversations", tags=["conversations"])
api_router.include_router(friends.router, prefix="/friends", tags=["friends"])
api_router.include_router(blocks.router, prefix="/blocks", tags=["blocks"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(games.router, prefix="/games", tags=["games"])
api_router.include_router(chess.router, prefix="/chess", tags=["chess"])
api_router.include_router(beats.router, prefix="/beats", tags=["beats"])
api_router.include_router(mtg.router, prefix="/mtg", tags=["mtg"])
