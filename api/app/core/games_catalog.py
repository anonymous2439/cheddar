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
        "platforms": ["web", "vscode"],
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
        "platforms": ["web", "vscode"],
    },
    {
        "key": "cheddar_beats",
        "name": "Cheddar Beats",
        "min_players": 1,
        "max_players": 8,
        # A chart has to finish playing out before the leader can "Back to
        # Lobby" — same completion-gating as Karirs/Chess, driven by
        # beats.py's own session resolution.
        "tracks_completion": True,
        "platforms": ["web", "vscode"],
    },
    {
        "key": "cheddar_mtg",
        "name": "Cheddar MTG",
        "min_players": 2,
        "max_players": 2,
        # No rules engine — players read their own cards and self-apply
        # them, so there's no automatic win detection. The match only ends
        # when a player concedes (mtg.py's /concede), same completion-
        # gating mechanism as Chess/Beats, just driven manually instead of
        # a checkmate/timer.
        "tracks_completion": True,
        # Web-only for now — no vscode client implementation yet.
        "platforms": ["web"],
    },
]

GAMES_BY_KEY = {game["key"]: game for game in GAMES}
