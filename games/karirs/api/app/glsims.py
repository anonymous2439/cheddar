"""Presentation-layer filtering for GL Sims' live conversation feed (see
main.py's get_glsims_conversations) — separated out from that endpoint
purely to keep main.py's already-long flat list of routes from growing a
big regex block inline.

Ported from the old scripts/export_glsims_conversations.py, which used to
turn conversation_lines into a static file GL Sims read at build time.
That script (and the static file it produced) is gone now — GL Sims fetches
this filtering live, on every request, so an edit to conversation_lines or
to the filtered_messages table (see models.py's FilteredMessage) shows up
the next time GL Sims mounts, no client rebuild required.
"""

import re

# Anchored (^...$) on purpose — these only match a line that is *entirely*
# a system notice, not an ordinary message that happens to mention "added"
# or "unsent" in passing (plenty of those in the real data, e.g. someone
# joking "cge lng tag unsent pero...").
SYSTEM_NOTICE_PATTERNS = [
    re.compile(r"^[\w .'\-]+ added .+ to the group\.?$", re.I),
    re.compile(r"^[\w .'\-]+ removed .+ from the group\.?$", re.I),
    re.compile(r"^[\w .'\-]+ left the group\.?$", re.I),
    re.compile(r"^[\w .'\-]+ changed the group.?s? (name|photo|profile picture|nickname).*$", re.I),
    re.compile(r"^[\w .'\-]+ named the group.*$", re.I),
    re.compile(r"^[\w .'\-]+ set (his|her|their|the nickname).*$", re.I),
    re.compile(r"^[\w .'\-]+ changed their nickname.*$", re.I),
    re.compile(r"^[\w .'\-]+ unsent a message\.?$", re.I),
    re.compile(r"^unsent a message\.?$", re.I),
    re.compile(r"^unsent\.?$", re.I),
    re.compile(r"^[\w .'\-]+ (reacted|liked) .+ (to|message).*$", re.I),
    re.compile(r"^[\w .'\-]+ started (a )?call\.?$", re.I),
    re.compile(r"^[\w .'\-]+ (joined|answered) the (call|video chat)\.?$", re.I),
    re.compile(r"^[\w .'\-]+ changed the (chat colou?r|theme|emoji).*$", re.I),
    re.compile(r"^[\w .'\-]+ pinned a message.*$", re.I),
    re.compile(r"^added a new note\.?$", re.I),
]


def is_filtered_message(message: str, filtered_exact: set[str]) -> bool:
    """filtered_exact is expected pre-lowercased/stripped (see
    get_glsims_conversations, which builds it once per request from
    FilteredMessage rows) — a plain content-moderation list, checked before
    the structural regex patterns above."""
    stripped = message.strip()
    if stripped.lower() in filtered_exact:
        return True
    return any(p.match(stripped) for p in SYSTEM_NOTICE_PATTERNS)
