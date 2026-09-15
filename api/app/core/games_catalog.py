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
    {
        "key": "pokemon_fire_red",
        "name": "Pokémon Fire Red",
        "min_players": 1,
        "max_players": 8,
        # Open-ended — no win condition, so unlike every other game here
        # the leader should be able to "Back to Lobby" any time, not just
        # once some session-resolution call fires (see restart_lobby's
        # tracks_completion gate below).
        "tracks_completion": False,
        # Web-only — an iframe-hosted mgba-wasm workaround was tried and
        # abandoned in the vscode extension after hitting what looks like
        # a structural conflict between vscode's own webview sandboxing
        # and mgba-wasm's Worker/SharedArrayBuffer requirements, not
        # something fixable from the extension side.
        "platforms": ["web"],
    },
    {
        "key": "luba",
        "name": "Luba",
        "min_players": 2,
        "max_players": 8,
        # Both match modes (respawn deathmatch, battle-royale) have a real
        # end state.
        "tracks_completion": True,
        "platforms": ["web", "vscode"],
    },
    {
        "key": "glsims",
        "name": "GL Sims",
        "min_players": 1,
        "max_players": 1,
        # A pure local screensaver — no networking, no server-side session
        # of any kind, every client just runs its own independent
        # simulation. No win condition, so (like Pokémon Fire Red) the
        # leader can "Back to Lobby" any time rather than waiting on a
        # completion signal that will never come.
        "tracks_completion": False,
        # vscode-only per the user's explicit instruction.
        "platforms": ["vscode"],
    },
    {
        "key": "model_viewer",
        "name": "Model Viewer",
        "min_players": 1,
        "max_players": 1,
        # Same reasoning as GL Sims/Pokémon Fire Red — a single local
        # viewer with no server-side session or win condition at all.
        "tracks_completion": False,
        # Now also on vscode — its client fetches the FBX/textures at
        # runtime straight from this server (see games/modelviewer/client)
        # rather than bundling the ~71MB asset set into the extension.
        "platforms": ["web", "vscode"],
        # Still a work in progress — hidden from the normal catalog on any
        # client that respects the flag; the vscode extension's /games
        # command only shows it via the explicit /games hidden form. Drop
        # this once it's ready for everyone to find normally.
        "hidden": True,
    },
]

GAMES_BY_KEY = {game["key"]: game for game in GAMES}
