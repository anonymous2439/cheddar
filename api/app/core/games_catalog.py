GAMES = [
    {
        "key": "karirs",
        "name": "Karirs",
        "min_players": 1,
        "max_players": 8,
        # Karirs has a real race session running behind the lobby (betting +
        # animated race), so the leader can't "Back to Lobby" until the game
        # module itself reports the race resolved via POST .../finish.
        "tracks_completion": True,
    },
    {
        "key": "chess",
        "name": "Chess",
        "min_players": 2,
        "max_players": 2,
        # A live game has to actually conclude (checkmate/stalemate/draw/
        # resignation) before the leader can "Back to Lobby" — same
        # completion-gating as Karirs, just driven by chess.py's own
        # resolution instead of a race resolving.
        "tracks_completion": True,
    },
]

GAMES_BY_KEY = {game["key"]: game for game in GAMES}
