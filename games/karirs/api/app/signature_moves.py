# Each racer's anime-style catchphrase, shouted whenever their speed rolls
# into the peak band (see race.py's PEAK_SPEED_THRESHOLD). Keyed by the same
# names seeded in roster.py. Split into its own module (rather than living in
# roster.py or models.py) so both can import it without a circular import —
# roster.py already imports from models.py, and models.py needs this too
# (Race.signature_moves).
SIGNATURE_MOVES: dict[str, str] = {
    "Neil Axinto": "🚀 Turbo Neil!",
    "Aby Calago": "🌪️ Aby Cyclone!",
    "Ashley Bayarcal": "✨ Starlight Dash!",
    "Brian Lisondra": "🔥 Blazing Brian!",
    "Carl Perral": "⚡ Carl's Overdrive!",
    "Chaimel Enjambre": "💀 Newbie Slayer!",
    "Elieser Tajanlangit": "🌊 Tidal Elieser!",
    "Jayson Martinez": "🎯 Bullseye Blitz!",
    "Jerome Madelo": "🥷 Shadow Step!",
    "Jhoewell Posas": "🐉 Dragon's Roar!",
    "Jhon Pabroa": "🌀 Whirlwind Jhon!",
    "John Macapaz": "💥 Sonic Boom!",
    "John Leo Salac": "🦁 Lion's Pride!",
    "Jonah Taganahan": "🌟 Falling Star!",
    "Joshua Paulo": "⚔️ Blade Rush!",
    "Troy Alonsagay": "🏹 Arrow of Troy!",
    "Grace Vellina": "👑 Graceful Fury!",
    "Mat Ando": "🔨 Hammer Time!",
    "Michael Tonilon": "🚨 Code Red!",
    "Mike Miñoza": "🎸 Rockstar Rev!",
    "Novel Chavez": "📖 Plot Twist!",
    "Percival Mansueto": "🛡️ Iron Wall Charge!",
    "Rashed Perez": "💨 Rashed Rocket!",
    "Roland Clarion": "🔔 Clarion Call!",
    "Xiao": "🐼 Panda Dash!",
}


def signature_move_for(name: str) -> str:
    return SIGNATURE_MOVES.get(name, f"{name}'s Signature Move!")
