// Cheddar Beats — vscode client module, vendored into the Cheddar extension.
//
// Players don't share one synchronized note timeline — each independently
// cycles level 1→9→1... at their own pace: press the level-length key
// sequence in order (arrows for 4key; arrows + WASD for 8key), then time a
// spacebar press against a sliding gauge. The server (main Cheddar API's
// /api/v1/beats) picks each round's sequence and owns the shared 60s
// match-clock anchor; this client only renders and reports its own judged
// attempts. The live leaderboard updates continuously as each player's own
// attempts land — no barrier/waiting on anyone else (see beats.py's
// submit_attempt).
//
// The gauge sweep is a pure function of matchElapsed (time since the
// match's own started_at anchor) rather than a per-round timer — that's
// what makes it run continuously for the whole match with no pause between
// rounds: each sweepMs-long span is one "cycle" (one move's worth of
// opportunity), back to back with no gap, and the round for the next cycle
// is prefetched one cycle ahead so the rollover at each boundary is instant.
(function () {
    const SWEEP_BEATS = 6;
    const STATIC_POS = 0.85;
    const WINDOWS = [
        { judgment: 'perfect', ms: 30 },
        { judgment: 'great', ms: 60 },
        { judgment: 'cool', ms: 100 },
        { judgment: 'bad', ms: 150 },
    ];
    const ARROW_GLYPH = {
        up: '↑', down: '↓', left: '←', right: '→',
        up_left: '↖', up_right: '↗', down_left: '↙', down_right: '↘',
    };
    const JUDGMENT_COLOR = {
        perfect: '#ffd700',
        great: '#4caf50',
        cool: '#38bdf8',
        bad: '#8b4513',
        miss: '#ef4444',
    };
    // How long the spacebar-press "explosion" burst on the bar takes to
    // expand and fade out.
    const EXPLOSION_DURATION_MS = 400;

    // Reverse Mode (DEL key): up to 6 of the round's keys are displayed as
    // their opposite direction, in red, as a "what you see is not what you
    // press" challenge — the player still has to press the true, un-flipped
    // symbol (the sequence itself never changes, only the glyph shown does).
    const OPPOSITE_SYMBOL = {
        up: 'down', down: 'up', left: 'right', right: 'left',
        up_left: 'down_right', down_right: 'up_left',
        up_right: 'down_left', down_left: 'up_right',
    };
    const MAX_REVERSED_KEYS = 6;
    // Flat bonus Reverse Mode adds on top of the chain multiplier — mirrors
    // REV_MODE_BONUS in beats.py; kept in sync for the instant local
    // display, while the server independently computes (and trusts) the
    // real score.
    const REV_MODE_BONUS = 1.1;

    function pickReversedIndices(sequenceLength) {
        const indices = Array.from({ length: sequenceLength }, (_, i) => i);
        if (indices.length <= MAX_REVERSED_KEYS) return new Set(indices);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        return new Set(indices.slice(0, MAX_REVERSED_KEYS));
    }

    function effectiveMultiplier(chainValue, rev) {
        const chainMultiplier = chainValue >= 2 ? chainValue : 1;
        return rev ? Math.round(chainMultiplier * REV_MODE_BONUS * 100) / 100 : chainMultiplier;
    }

    function formatMultiplier(m) {
        if (Number.isInteger(m)) return String(m);
        return m.toFixed(2).replace(/0$/, '');
    }

    function hexToRgbTriplet(hex) {
        const n = parseInt(hex.slice(1), 16);
        return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    }
    // 8key is the 4 arrows plus the 4 diagonals, reachable from the numpad's
    // navigation cluster with Num Lock off — 7/9/1/3 send Home/PageUp/End/
    // PageDown, the corners of the 7-8-9/4-5-6/1-2-3 grid, diagonal to the
    // arrow keys at 8/4/6/2. Browsers report the same `key` value whether
    // the press came from the numpad or a dedicated nav-cluster key, so
    // either works.
    const KEY_TO_SYMBOL = {
        arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
        home: 'up_left', pageup: 'up_right', end: 'down_left', pagedown: 'down_right',
    };

    let ctx = null;
    let container = null;
    let matchState = null;
    let standings = [];
    let level = 1;
    let round = null;
    let nextRound = null;
    let sequenceProgress = 0;
    let activeCycle = 0;
    let roundSettled = false;
    let finished = false;
    let flash = null;
    // A one-shot burst drawn on the bar at the exact spot the sliding
    // circle was when the player pressed space — self-clears after
    // EXPLOSION_DURATION_MS. { judgment, x, startTime } | null.
    let explosion = null;
    // Consecutive-perfect streak, from the server's own attempt_ack (see
    // beats.py's submit_attempt) — the multiplier is this value once it
    // reaches 2+; below that it's a normal, unmultiplied score and stays
    // hidden.
    let chain = 0;
    // Reverse Mode: a player-local toggle (DEL key), not synced with other
    // players — each player challenges themself independently.
    let revActive = false;
    // Indices into round.sequence currently displayed flipped/red — recomputed
    // whenever a round starts/rolls over, so each round gets its own random
    // set (not the same positions reused all match).
    let reversedIndices = new Set();

    let matchStartTimer = null;
    let flashTimer = null;
    let rafId = null;
    let keydownHandler = null;

    let titleEl, infoEl, sequenceRowEl, canvas, chainEl, revLabelEl, hintEl, standingsListEl;

    function refreshReversedIndices(sequenceLength) {
        reversedIndices = revActive ? pickReversedIndices(sequenceLength) : new Set();
    }

    function sweepMs(bpm) {
        return (60000 / bpm) * SWEEP_BEATS;
    }

    function judgmentFor(deltaMs) {
        const abs = Math.abs(deltaMs);
        for (const w of WINDOWS) {
            if (abs <= w.ms) return w.judgment;
        }
        return 'miss';
    }

    function nameFor(userId) {
        const user = (ctx.participants || []).find((p) => p.id === userId);
        return user ? user.username : `user#${userId}`;
    }

    function mount(el, mountCtx) {
        container = el;
        ctx = mountCtx;
        matchState = null;
        standings = [];
        level = 1;
        round = null;
        nextRound = null;
        sequenceProgress = 0;
        activeCycle = 0;
        roundSettled = false;
        finished = false;
        flash = null;
        explosion = null;
        chain = 0;
        revActive = false;
        reversedIndices = new Set();

        buildChrome();
        render();
        window.CheddarHost.send('get_state', { lobbyId: ctx.lobbyId });

        keydownHandler = onKeyDown;
        window.addEventListener('keydown', keydownHandler);
        rafId = requestAnimationFrame(tick);
    }

    function unmount() {
        if (keydownHandler) window.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        if (flashTimer) clearTimeout(flashTimer);
        if (matchStartTimer) clearTimeout(matchStartTimer);
        container = null;
        titleEl = infoEl = sequenceRowEl = canvas = chainEl = revLabelEl = hintEl = standingsListEl = null;
    }

    function requestRound(lvl) {
        window.CheddarHost.send('round', { lobbyId: ctx.lobbyId, level: lvl });
    }

    // The first round mustn't start until the shared countdown actually
    // reaches zero — otherwise its cycle is already ticking away before the
    // player can even see the sequence to press.
    function scheduleFirstRound(s) {
        if (matchStartTimer) clearTimeout(matchStartTimer);
        const delay = new Date(s.started_at + 'Z').getTime() - Date.now();
        if (delay <= 0) {
            requestRound(1);
        } else {
            matchStartTimer = setTimeout(() => requestRound(1), delay);
        }
    }

    function onEvent(event, data) {
        if (event === 'state') {
            matchState = data;
            standings = data.standings;
            if (!round) scheduleFirstRound(data);
            render();
        } else if (event === 'round') {
            if (!round) {
                // The very first round of the match.
                round = data;
                level = data.level;
                activeCycle = 0;
                sequenceProgress = 0;
                roundSettled = false;
                refreshReversedIndices(round.sequence.length);
                requestRound((level % 9) + 1);
            } else {
                // A prefetch for the cycle after the one currently playing.
                nextRound = data;
            }
            render();
        } else if (event === 'standing') {
            standings = data.standings;
            render();
        } else if (event === 'attempt_ack') {
            chain = data.chain;
            render();
        } else if (event === 'error') {
            // Only surface this if it isn't just a stale response for a
            // request that a WS broadcast has already superseded — e.g. this
            // client's own get_state can legitimately 404 if it reaches the
            // server just before this same client's own createBeatsSession
            // call does; showing that error after matchState already
            // arrived would leave a permanently-misleading stale message.
            if (!matchState) {
                hintEl.textContent = data.message;
            }
        }
    }

    // Scores this cycle's attempt but does NOT touch the gauge/level/round —
    // the sweep just keeps going uninterrupted; the actual rollover to the
    // next round happens purely from tick() noticing the cycle boundary,
    // using whatever requestRound() already prefetched.
    function recordAttempt(judgment) {
        if (roundSettled || !round) return;
        roundSettled = true;
        flash = { judgment, moveName: round.move_name };
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
            flash = null;
        }, 700);
        window.CheddarHost.send('attempt', { lobbyId: ctx.lobbyId, level, judgment, revActive });
    }

    // `progress` is the sliding circle's position (0-1 along the bar) at
    // the instant space was pressed — the burst appears right where the
    // circle actually was, not at the target, so it visually shows how
    // close the press was.
    function triggerExplosion(judgment, progress) {
        if (!canvas) return;
        const pad = 16;
        const barWidth = canvas.width - pad * 2;
        const x = pad + Math.max(0, Math.min(1, progress)) * barWidth;
        explosion = { judgment, x, startTime: Date.now() };
    }

    function onKeyDown(e) {
        if (e.key === 'Delete') {
            e.preventDefault();
            if (!matchState || finished) return;
            revActive = !revActive;
            refreshReversedIndices(round ? round.sequence.length : 0);
            render();
            return;
        }

        if (!matchState || !round || roundSettled || finished) return;

        if (e.key === ' ' || e.code === 'Space') {
            const startedAtMs = new Date(matchState.started_at + 'Z').getTime();
            const matchElapsed = Date.now() - startedAtMs;
            const cycleMs = sweepMs(matchState.bpm);
            const withinCycle = matchElapsed - activeCycle * cycleMs;

            if (sequenceProgress < round.sequence.length) {
                triggerExplosion('miss', withinCycle / cycleMs);
                recordAttempt('miss');
                return;
            }
            const perfectMs = STATIC_POS * cycleMs;
            const judgment = judgmentFor(withinCycle - perfectMs);
            triggerExplosion(judgment, withinCycle / cycleMs);
            recordAttempt(judgment);
            return;
        }

        const symbol = KEY_TO_SYMBOL[e.key.toLowerCase()];
        if (!symbol) return;
        // Home/End/PageUp/PageDown otherwise scroll the page — same
        // reasoning as preventDefault on Space above.
        e.preventDefault();
        // Sequence already fully entered — extra presses are harmless
        // no-ops, not a wrong-key reset. Only SPACE matters now.
        if (sequenceProgress >= round.sequence.length) return;
        const expected = round.sequence[sequenceProgress];
        if (symbol === expected) {
            sequenceProgress += 1;
        } else {
            sequenceProgress = 0;
        }
        render();
    }

    function tick() {
        if (matchState && !finished) {
            const startedAtMs = new Date(matchState.started_at + 'Z').getTime();
            const matchElapsed = Date.now() - startedAtMs;
            if (matchElapsed >= matchState.duration_seconds * 1000) {
                finished = true;
                window.CheddarHost.finishGame();
            } else if (matchElapsed >= 0 && round && canvas) {
                const cycleMs = sweepMs(matchState.bpm);
                const cycleIndex = Math.floor(matchElapsed / cycleMs);
                const withinCycle = matchElapsed - cycleIndex * cycleMs;

                if (cycleIndex > activeCycle) {
                    if (!roundSettled) recordAttempt('miss');
                    activeCycle = cycleIndex;
                    const nextLevel = (level % 9) + 1;
                    level = nextLevel;
                    round = nextRound || round;
                    nextRound = null;
                    sequenceProgress = 0;
                    roundSettled = false;
                    refreshReversedIndices(round ? round.sequence.length : 0);
                    requestRound((nextLevel % 9) + 1);
                    render();
                }

                drawGauge(withinCycle);
            }
        }
        renderInfoLine();
        rafId = requestAnimationFrame(tick);
    }

    function buildChrome() {
        container.innerHTML = '';

        titleEl = document.createElement('p');
        titleEl.style.fontWeight = '600';
        titleEl.textContent = `🎵 ${ctx.gameName}`;
        container.appendChild(titleEl);

        infoEl = document.createElement('p');
        container.appendChild(infoEl);

        sequenceRowEl = document.createElement('div');
        sequenceRowEl.style.display = 'flex';
        sequenceRowEl.style.gap = '6px';
        sequenceRowEl.style.margin = '6px 0';
        container.appendChild(sequenceRowEl);

        canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 50;
        canvas.style.background = '#111827';
        canvas.style.border = '1px solid #374151';
        container.appendChild(canvas);

        const multiplierEl = document.createElement('div');
        multiplierEl.style.display = 'flex';
        multiplierEl.style.alignItems = 'center';
        multiplierEl.style.justifyContent = 'center';
        multiplierEl.style.gap = '4px';
        // Matches canvas.width below — otherwise centering would span the
        // whole (possibly much wider) container instead of sitting under
        // the beat bar itself.
        multiplierEl.style.width = '320px';
        multiplierEl.style.margin = '4px 0 0';
        multiplierEl.style.fontWeight = 'bold';
        multiplierEl.style.fontSize = '16px';
        container.appendChild(multiplierEl);

        revLabelEl = document.createElement('span');
        revLabelEl.style.color = JUDGMENT_COLOR.miss;
        multiplierEl.appendChild(revLabelEl);

        chainEl = document.createElement('span');
        chainEl.style.color = JUDGMENT_COLOR.perfect;
        multiplierEl.appendChild(chainEl);

        hintEl = document.createElement('p');
        hintEl.style.fontSize = '12px';
        hintEl.style.opacity = '0.7';
        hintEl.textContent = 'Complete the sequence, then press SPACE at the right moment.';
        container.appendChild(hintEl);

        const standingsHeader = document.createElement('p');
        standingsHeader.style.margin = '8px 0 2px';
        standingsHeader.style.fontWeight = '600';
        standingsHeader.textContent = 'Standings';
        container.appendChild(standingsHeader);

        standingsListEl = document.createElement('div');
        standingsListEl.style.fontFamily = 'monospace';
        standingsListEl.style.fontSize = '12px';
        standingsListEl.style.whiteSpace = 'pre-line';
        container.appendChild(standingsListEl);
    }

    function renderInfoLine() {
        if (!infoEl || !matchState) return;
        const matchElapsed = Date.now() - new Date(matchState.started_at + 'Z').getTime();
        const secondsLeft = Math.max(0, Math.ceil((matchState.duration_seconds * 1000 - matchElapsed) / 1000));
        if (matchElapsed < 0) {
            infoEl.style.color = '';
            infoEl.textContent = `Level ${level} · ${matchState.mode} — starting in ${Math.ceil(-matchElapsed / 1000)}…`;
        } else if (flash) {
            infoEl.style.color = JUDGMENT_COLOR[flash.judgment];
            infoEl.textContent = `${flash.judgment.toUpperCase()}${flash.moveName ? ' — ' + flash.moveName : ''}`;
        } else {
            infoEl.style.color = '';
            infoEl.textContent = `Level ${level} · ${matchState.mode} · ${secondsLeft}s left`;
        }
    }

    function render() {
        if (!container || !sequenceRowEl) return;

        sequenceRowEl.innerHTML = '';
        (round ? round.sequence : []).forEach((sym, i) => {
            const box = document.createElement('div');
            box.style.width = '28px';
            box.style.height = '28px';
            box.style.display = 'flex';
            box.style.alignItems = 'center';
            box.style.justifyContent = 'center';
            box.style.fontWeight = 'bold';
            box.style.border = '1px solid';
            if (i < sequenceProgress) {
                box.style.borderColor = '#4caf50';
                box.style.color = '#4caf50';
            } else if (i === sequenceProgress) {
                box.style.borderColor = '#f5c542';
                box.style.color = '#f5c542';
            } else {
                box.style.borderColor = '#555';
                box.style.color = '#888';
            }
            const isReversed = reversedIndices.has(i);
            const displaySym = isReversed ? (OPPOSITE_SYMBOL[sym] || sym) : sym;
            if (isReversed) box.style.color = JUDGMENT_COLOR.miss;
            box.textContent = ARROW_GLYPH[displaySym] || displaySym;
            sequenceRowEl.appendChild(box);
        });

        renderInfoLine();

        revLabelEl.textContent = revActive ? 'REV' : '';
        chainEl.textContent = `×${formatMultiplier(effectiveMultiplier(chain, revActive))}`;

        standingsListEl.textContent = standings
            .map((s) => `#${s.rank} @${nameFor(s.user_id)} — ${s.score}`)
            .join('\n');
    }

    // A soft, feathered glow around the target circle that grows/shrinks and
    // fades in/out smoothly. Phase-locked to the perfect-beat instant (not
    // just evenly spaced across the whole sweep) so the heartbeat's final,
    // fullest expansion always lands exactly when the sliding circle
    // reaches the target — pulse_count beats build up to it, one per
    // period, and it gently fades out again over the remaining tail.
    function drawHeartbeat(c, x, y, withinCycle) {
        const cycleMs = sweepMs(matchState.bpm);
        const targetMs = STATIC_POS * cycleMs;
        let pulse;
        if (withinCycle <= targetMs) {
            const period = targetMs / matchState.pulse_count;
            const phase = (withinCycle - targetMs) / period; // 0 exactly at the target, negative before it
            pulse = (Math.cos(phase * 2 * Math.PI) + 1) / 2;
        } else {
            const tailProgress = (withinCycle - targetMs) / (cycleMs - targetMs); // 0..1
            pulse = Math.cos((tailProgress * Math.PI) / 2); // eases 1 -> 0, no post-target beats
        }
        const radius = 5 + pulse * 14;
        const alpha = 0.15 + pulse * 0.45;
        const gradient = c.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(245, 197, 66, ${alpha})`);
        gradient.addColorStop(1, 'rgba(245, 197, 66, 0)');
        c.fillStyle = gradient;
        c.beginPath();
        c.arc(x, y, radius, 0, Math.PI * 2);
        c.fill();
    }

    // Reads the pending explosion (if any) and clears it once its animation
    // has fully played out — read once per frame and shared by both places
    // it gets drawn (the full-bar wash and the localized burst), rather
    // than each re-reading (and potentially racing to clear) the variable.
    function readExplosion() {
        if (!explosion) return null;
        const elapsed = Date.now() - explosion.startTime;
        if (elapsed > EXPLOSION_DURATION_MS) {
            explosion = null;
            return null;
        }
        return { judgment: explosion.judgment, x: explosion.x, progress: elapsed / EXPLOSION_DURATION_MS };
    }

    // withinCycle is always in [0, sweepMs) — the position sawtooths back to
    // the start at each cycle boundary rather than pausing, the same way a
    // metronome needle snaps back rather than freezing.
    function drawGauge(withinCycle) {
        const c = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const barY = h / 2;
        const pad = 16;
        const barWidth = w - pad * 2;
        const ex = readExplosion();

        c.fillStyle = '#111827';
        c.fillRect(0, 0, w, h);

        // A judgment-colored wash across the whole bar container, on top of
        // the base background but under everything else — the localized
        // burst below is the sharp, precise part of the effect; this is the
        // container-wide reaction to it.
        if (ex) {
            const rgb = hexToRgbTriplet(JUDGMENT_COLOR[ex.judgment]);
            c.fillStyle = `rgba(${rgb}, ${(1 - ex.progress) * 0.35})`;
            c.fillRect(0, 0, w, h);
        }

        c.strokeStyle = '#374151';
        c.lineWidth = 4;
        c.beginPath();
        c.moveTo(pad, barY);
        c.lineTo(pad + barWidth, barY);
        c.stroke();

        const staticX = pad + STATIC_POS * barWidth;
        drawHeartbeat(c, staticX, barY, withinCycle);
        c.beginPath();
        c.arc(staticX, barY, 8, 0, Math.PI * 2);
        c.strokeStyle = '#f5c542';
        c.lineWidth = 3;
        c.stroke();

        const progress = withinCycle / sweepMs(matchState.bpm);
        const slideX = pad + progress * barWidth;
        c.beginPath();
        c.arc(slideX, barY, 6, 0, Math.PI * 2);
        c.fillStyle = '#4caf50';
        c.fill();

        // The sharp, localized burst — drawn last so it sits on top of the
        // bar, heartbeat, and both circles.
        if (ex) {
            const radius = 8 + ex.progress * 35;
            const alpha = (1 - ex.progress) * 0.9;
            const rgb = hexToRgbTriplet(JUDGMENT_COLOR[ex.judgment]);
            const gradient = c.createRadialGradient(ex.x, barY, 0, ex.x, barY, radius);
            gradient.addColorStop(0, `rgba(${rgb}, ${alpha})`);
            gradient.addColorStop(1, `rgba(${rgb}, 0)`);
            c.fillStyle = gradient;
            c.beginPath();
            c.arc(ex.x, barY, radius, 0, Math.PI * 2);
            c.fill();
        }
    }

    window.CheddarGames = window.CheddarGames || {};
    window.CheddarGames['cheddar_beats'] = { mount, unmount, onEvent };
})();
