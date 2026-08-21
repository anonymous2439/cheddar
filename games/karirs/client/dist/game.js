// Karirs — a Philippine "karera" (video horse-racing betting) style game.
// Racers are a fixed roster the Karirs API deals out itself (not the lobby's
// players), betting is anonymous (only aggregate pool totals are visible),
// and once the 30s betting window closes the server computes the *entire*
// race in one shot and ships it as one message (see extension.ts's
// ensureKarirsRaceSocket) — this client replays it locally, timed off the
// race's betting_closes_at, rather than animating from live per-step
// pushes. No "start"/"resolve" action here at all.
(function () {
    // Must match games/karirs/api/app/main.py's STEP_DELAY_SECONDS.
    const STEP_DELAY_MS = 300;

    let ctx = null;
    let container = null;
    let wallet = null;
    let race = null;
    let pool = null;
    let myBet = null;
    let selectedRacer = null;
    let errorText = '';
    let pollTimer = null;
    let tickTimer = null;

    // The whole precomputed race (index 0 = step 1) plus the wall-clock
    // instant it started — independent of the REST-polled `race` above,
    // which can lag a couple of seconds behind. Positions for "right now"
    // are always derived from these via currentStepInfo(), never stored
    // directly, so a reconnect mid-race just works: elapsed time since
    // stepsAnchorAt already reflects wherever the race actually is.
    let raceSteps = null;
    let stepsAnchorAt = null;

    function currentStepInfo() {
        if (!raceSteps || !stepsAnchorAt) return null;
        const elapsedMs = Math.max(0, Date.now() - stepsAnchorAt);
        const idx = Math.floor(elapsedMs / STEP_DELAY_MS);
        if (idx >= raceSteps.length) {
            return { positions: raceSteps[raceSteps.length - 1], step: raceSteps.length, total: raceSteps.length, done: true };
        }
        return { positions: raceSteps[idx], step: idx + 1, total: raceSteps.length, done: false };
    }

    // The track's own DOM persists across step updates (see ensureTrackDom/
    // updateTrackDots below) — a CSS transition only animates a property
    // change on an element that already existed with the old value; tearing
    // the dots down and recreating them every 0.3s (which a full innerHTML
    // rebuild would do) means each one just appears at its new spot with no
    // interpolation, however long a `transition` is declared for.
    let trackWrapperEl = null;
    let trackDots = {};
    let trackRaceId = null;

    function mount(el, mountCtx) {
        container = el;
        ctx = mountCtx;
        wallet = null;
        race = null;
        pool = null;
        myBet = null;
        selectedRacer = null;
        errorText = '';
        raceSteps = null;
        stepsAnchorAt = null;
        trackWrapperEl = null;
        trackDots = {};
        trackRaceId = null;
        render();

        window.CheddarHost.send('sync_race', { lobbyId: ctx.lobbyId });
        window.CheddarHost.send('wallet', {});

        pollTimer = setInterval(poll, 2000);
        // Fast enough to advance the track a step at a time in sync with the
        // server's cadence (see STEP_DELAY_MS) — cheap either way, this is a
        // handful of DOM nodes.
        tickTimer = setInterval(render, 200);
    }

    function unmount() {
        if (pollTimer) clearInterval(pollTimer);
        if (tickTimer) clearInterval(tickTimer);
        pollTimer = null;
        tickTimer = null;
        trackWrapperEl = null;
        trackDots = {};
        trackRaceId = null;
        if (container) container.innerHTML = '';
        container = null;
        ctx = null;
    }

    function poll() {
        if (!race || race.status !== 'betting_open') return;
        window.CheddarHost.send('sync_race', { lobbyId: ctx.lobbyId });
        window.CheddarHost.send('pool', { raceId: race.id });
    }

    function onEvent(event, data) {
        errorText = '';

        if (event === 'race') {
            // my_bet only needs fetching twice: once to restore state on
            // first load, once more on resolution to pick up the final
            // payout — NOT on every poll tick. Polling repeatedly fired
            // uncorrelated my_bet requests whose (pre-resolution, null-
            // payout) responses could land after the resolved one and
            // clobber a correct payout with a stale null.
            const isFirstLoad = race === null;
            const justResolved = race && race.status === 'betting_open' && data.status === 'resolved';
            race = data;

            // A REST sync can land after betting already closed (a fresh
            // mount, or a reconnect) — race.steps is already the whole
            // precomputed animation by then, same as if it had arrived over
            // the socket, so this is enough to start replaying it locally.
            if (race.steps) {
                raceSteps = race.steps;
                stepsAnchorAt = new Date(race.betting_closes_at + 'Z').getTime();
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            }

            if (isFirstLoad || justResolved) {
                window.CheddarHost.send('pool', { raceId: race.id });
                window.CheddarHost.send('my_bet', { raceId: race.id });
            }
            // Tell the lobby the race is over so the leader can go back to
            // it — covers both a live resolution and reconnecting straight
            // into an already-resolved race.
            if (race.status === 'resolved' && (isFirstLoad || justResolved)) {
                window.CheddarHost.finishGame();
            }
        } else if (event === 'wallet') {
            wallet = data;
        } else if (event === 'pool') {
            pool = data;
        } else if (event === 'my_bet') {
            const incoming = data && data.length ? data[0] : null;
            // Belt-and-braces: never let a stale pre-resolution response
            // (payout still null) overwrite an already-known final payout.
            const isStale = race && race.status === 'resolved' && incoming && incoming.payout == null && myBet && myBet.payout != null;
            if (!isStale) myBet = incoming;
        } else if (event === 'bet_placed') {
            myBet = data;
            window.CheddarHost.send('wallet', {});
            window.CheddarHost.send('pool', { raceId: race.id });
        } else if (event === 'race_steps') {
            // The whole animation, in one message — not a per-tick push.
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            raceSteps = data.steps;
            // Unlike race.betting_closes_at (a naive REST field — needs the
            // client to append 'Z' itself), the API already appends 'Z' to
            // this WS field server-side (main.py: `.isoformat() + "Z"`).
            // Appending it again here silently produced an invalid date —
            // Date.parse gives NaN, not a throw — so raceSteps looked set
            // but currentStepInfo() always bailed, never showing a track.
            stepsAnchorAt = new Date(data.started_at).getTime();
            if (race) race.status = 'racing';
        } else if (event === 'race_finished') {
            race = data.race;
            pool = data.pool;
            window.CheddarHost.send('my_bet', { raceId: race.id });
            window.CheddarHost.finishGame();
        } else if (event === 'error') {
            errorText = data.message;
        }

        render();
    }

    function secondsLeft() {
        if (!race || !race.betting_closes_at) return 0;
        const closesAt = new Date(race.betting_closes_at + 'Z').getTime();
        return Math.max(0, Math.round((closesAt - Date.now()) / 1000));
    }

    // Everything except the track is cheap to fully rebuild every render and
    // never needs to animate, so it lives in its own wrapper that gets wiped
    // each time. trackWrapperEl is different: it's created once and never
    // wiped while a race's dots are live — see ensureTrackDom/updateTrackDots.
    let chromeTopEl = null;
    let chromeBottomEl = null;

    function ensureLayout() {
        if (trackWrapperEl && trackWrapperEl.parentNode === container) return;
        container.innerHTML = '';
        chromeTopEl = document.createElement('div');
        trackWrapperEl = document.createElement('div');
        chromeBottomEl = document.createElement('div');
        container.appendChild(chromeTopEl);
        container.appendChild(trackWrapperEl);
        container.appendChild(chromeBottomEl);
        trackDots = {};
        trackRaceId = null;
    }

    function clearTrack() {
        if (trackWrapperEl) trackWrapperEl.innerHTML = '';
        trackDots = {};
        trackRaceId = null;
    }

    function render() {
        if (!container) return;
        ensureLayout();
        chromeTopEl.innerHTML = '';
        chromeBottomEl.innerHTML = '';

        const walletLine = document.createElement('p');
        walletLine.textContent = wallet ? `💰 ${wallet.coins} coins` : '💰 …';
        chromeTopEl.appendChild(walletLine);

        if (!race) {
            const p = document.createElement('p');
            p.textContent = 'loading race…';
            chromeTopEl.appendChild(p);
            clearTrack();
            return;
        }

        const isRacing = race.status === 'racing';
        const isResolved = race.status === 'resolved';
        const stepInfo = isRacing || isResolved ? currentStepInfo() : null;

        if (!isRacing && !isResolved) {
            const title = document.createElement('p');
            title.textContent = `🏇 betting closes in ${secondsLeft()}s`;
            chromeTopEl.appendChild(title);
            clearTrack();
            renderBetting();
        } else {
            const title = document.createElement('p');
            title.textContent = isResolved
                ? `🏁 ${race.winning_name} wins!`
                : `🏇 racing… (${stepInfo ? stepInfo.step : 0}/${stepInfo ? stepInfo.total : 0})`;
            chromeTopEl.appendChild(title);
            if (stepInfo) {
                ensureTrackDom();
                updateTrackDots(stepInfo.positions);
            }
            if (isResolved) renderResult();
        }

        if (errorText) {
            const e = document.createElement('p');
            e.textContent = `⚠ ${errorText}`;
            e.style.color = '#ff8080';
            chromeBottomEl.appendChild(e);
        }
    }

    // Builds each racer's row/lane/dot exactly once per race — never torn
    // down and rebuilt on every step, since that's what was silently
    // defeating the dot's CSS transition (a transition only animates a style
    // change on an element that already existed with the old value; a
    // freshly-created element just appears at its target position with no
    // interpolation, no matter how the transition is declared).
    function ensureTrackDom() {
        if (trackRaceId === race.id && trackWrapperEl.childElementCount === race.racer_names.length) return;
        trackWrapperEl.innerHTML = '';
        trackDots = {};
        trackRaceId = race.id;

        race.racer_names.forEach((name) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '6px';
            row.style.margin = '3px 0';

            // Fixed-width label, ellipsized — a longer name must never affect
            // how far along its racer looks. The dot is what actually moves,
            // always the same size regardless of the name next to it.
            const label = document.createElement('span');
            label.style.width = '90px';
            label.style.flex = 'none';
            label.style.overflow = 'hidden';
            label.style.textOverflow = 'ellipsis';
            label.style.whiteSpace = 'nowrap';
            label.style.fontSize = '9px';
            row.appendChild(label);

            const lane = document.createElement('div');
            lane.style.position = 'relative';
            lane.style.flex = '1';
            lane.style.height = '14px';
            lane.style.background = '#ffffff14';
            lane.style.borderRadius = '3px';

            const dot = document.createElement('span');
            dot.style.position = 'absolute';
            dot.style.top = '50%';
            dot.style.left = '0%';
            dot.style.width = '8px';
            dot.style.height = '8px';
            dot.style.borderRadius = '50%';
            dot.style.transform = 'translate(-50%, -50%)';
            dot.style.transition = 'left 0.3s linear';
            lane.appendChild(dot);
            row.appendChild(lane);

            trackWrapperEl.appendChild(row);
            trackDots[name] = { label, dot };
        });
    }

    // Only mutates the existing dots/labels built above — this is what
    // actually lets the CSS transition on `left` animate smoothly.
    function updateTrackDots(positions) {
        race.racer_names.forEach((name) => {
            const els = trackDots[name];
            if (!els) return;
            const isMine = myBet && myBet.racer_name === name;
            const isWinner = race.status === 'resolved' && name === race.winning_name;
            const pct = Math.max(0, Math.min(100, positions[name] ?? 0));

            els.label.textContent = `${isMine ? '★ ' : ''}${name}${isWinner ? ' 🏆' : ''}`;
            els.label.style.color = isWinner ? '#ffd76a' : '#ffffffcc';
            els.dot.style.left = `${pct}%`;
            els.dot.style.background = isWinner ? '#ffd76a' : '#0080BAc4';
        });
    }

    // Plain unstyled <button>/<input> render with the browser's own default
    // control chrome, which stands out badly against the app's dark theme.
    // Same muted, semi-transparent gray already used for every other button
    // in the lobby chrome (lobby-ready/start/leave/restart/rejoin).
    function styleButton(el) {
        el.style.background = '#c4c4c454';
        el.style.color = '#ffffffaa';
        el.style.border = 'unset';
        el.style.padding = '2px 12px';
    }

    function styleInput(el) {
        el.style.background = '#c4c4c454';
        el.style.color = '#ffffffcc';
        el.style.border = 'unset';
        el.style.padding = '2px 6px';
    }

    function renderBetting() {
        const list = document.createElement('div');
        race.racer_names.forEach((name) => {
            const row = document.createElement('div');
            const total = pool ? (pool[name] ?? 0) : 0;
            const marker = !myBet && name === selectedRacer ? '▶ ' : '';

            if (myBet) {
                const label = document.createElement('span');
                label.textContent = `${name === myBet.racer_name ? '★ ' : ''}${name} — pool: ${total}`;
                row.appendChild(label);
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = `${marker}${name} — pool: ${total}`;
                styleButton(btn);
                btn.addEventListener('click', () => {
                    selectedRacer = name;
                    render();
                });
                row.appendChild(btn);
            }
            list.appendChild(row);
        });
        chromeTopEl.appendChild(list);

        if (myBet) {
            const p = document.createElement('p');
            p.textContent = `you bet ${myBet.wager} coins on ${myBet.racer_name} — nobody else can see that`;
            chromeTopEl.appendChild(p);
            return;
        }

        const wagerInput = document.createElement('input');
        wagerInput.type = 'number';
        wagerInput.min = '1';
        wagerInput.value = '50';
        wagerInput.style.width = '70px';
        styleInput(wagerInput);
        chromeTopEl.appendChild(wagerInput);

        const betBtn = document.createElement('button');
        betBtn.type = 'button';
        betBtn.textContent = 'Place Bet';
        styleButton(betBtn);
        betBtn.addEventListener('click', () => {
            const wager = parseInt(wagerInput.value, 10);
            if (!selectedRacer) {
                errorText = 'pick a racer first';
                render();
                return;
            }
            if (!wager || wager <= 0) {
                errorText = 'enter a valid wager';
                render();
                return;
            }
            window.CheddarHost.send('place_bet', { raceId: race.id, racerName: selectedRacer, wager });
        });
        chromeTopEl.appendChild(betBtn);
    }

    function renderResult() {
        if (!myBet) return;
        const p = document.createElement('p');
        p.textContent =
            myBet.payout > 0
                ? `you bet on ${myBet.racer_name} and won ${myBet.payout} coins!`
                : `you bet ${myBet.wager} on ${myBet.racer_name} — no payout this time.`;
        chromeBottomEl.appendChild(p);
    }

    window.CheddarGames = window.CheddarGames || {};
    window.CheddarGames['karirs'] = { mount, unmount, onEvent };
})();
