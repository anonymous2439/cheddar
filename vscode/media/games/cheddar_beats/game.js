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

    let matchStartTimer = null;
    let flashTimer = null;
    let rafId = null;
    let keydownHandler = null;

    let titleEl, infoEl, sequenceRowEl, canvas, hintEl, standingsListEl;

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
        titleEl = infoEl = sequenceRowEl = canvas = hintEl = standingsListEl = null;
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
                requestRound((level % 9) + 1);
            } else {
                // A prefetch for the cycle after the one currently playing.
                nextRound = data;
            }
            render();
        } else if (event === 'standing') {
            standings = data.standings;
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
        window.CheddarHost.send('attempt', { lobbyId: ctx.lobbyId, level, judgment });
    }

    function onKeyDown(e) {
        if (!matchState || !round || roundSettled || finished) return;

        if (e.key === ' ' || e.code === 'Space') {
            if (sequenceProgress < round.sequence.length) {
                recordAttempt('miss');
                return;
            }
            const startedAtMs = new Date(matchState.started_at + 'Z').getTime();
            const matchElapsed = Date.now() - startedAtMs;
            const cycleMs = sweepMs(matchState.bpm);
            const withinCycle = matchElapsed - activeCycle * cycleMs;
            const perfectMs = STATIC_POS * cycleMs;
            recordAttempt(judgmentFor(withinCycle - perfectMs));
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
            infoEl.textContent = `Level ${level} · ${matchState.mode} — starting in ${Math.ceil(-matchElapsed / 1000)}…`;
        } else if (flash) {
            infoEl.textContent = `${flash.judgment.toUpperCase()}${flash.moveName ? ' — ' + flash.moveName : ''}`;
        } else {
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
            box.textContent = ARROW_GLYPH[sym] || sym;
            sequenceRowEl.appendChild(box);
        });

        renderInfoLine();

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

        c.fillStyle = '#111827';
        c.fillRect(0, 0, w, h);

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
    }

    window.CheddarGames = window.CheddarGames || {};
    window.CheddarGames['cheddar_beats'] = { mount, unmount, onEvent };
})();
