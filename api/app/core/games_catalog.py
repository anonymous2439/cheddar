GAMES = [
    {
        "key": "signal_race",
        "name": "Signal Race",
        "min_players": 2,
        "max_players": 8,
    },
    {
        "key": "hello_world",
        "name": "Hello World",
        "min_players": 1,
        "max_players": 8,
    },
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
]

GAMES_BY_KEY = {game["key"]: game for game in GAMES}
