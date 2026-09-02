// Karirs — a Philippine "karera" (video horse-racing betting) style game.
// Racers are a fixed roster the Karirs API deals out itself (not the lobby's
// players), betting is anonymous (only aggregate pool totals are visible),
// and once the 30s betting window closes the server computes the *entire*
// race in one shot and ships it as one message (see extension.ts's
// ensureKarirsRaceSocket) — this client replays it locally, timed off the
// race's betting_closes_at, rather than animating from live per-step
// pushes. No "start"/"resolve" action here at all.
import { createKarirsScene3D } from './render3d.js';

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
    let scene3dRafId = null;

    // The 10 biggest wagers that ever actually won — fetched on demand when
    // the player opens it, not kept live/polled like everything else here.
    let hallOfFame = null;
    let showHallOfFame = false;
    // Bumped every time fresh hall-of-fame data arrives — reopening the
    // view shows whatever was last loaded immediately (no "loading…"
    // flicker for data we already have), but a *refresh* landing while
    // it's already open needs its own key change too, or the response
    // would replace `hallOfFame` silently without ever being rendered.
    let hallOfFameVersion = 0;

    // The whole precomputed race (index 0 = step 1) plus the wall-clock
    // instant it started — independent of the REST-polled `race` above,
    // which can lag a couple of seconds behind. Positions for "right now"
    // are always derived from these via currentStepInfo(), never stored
    // directly, so a reconnect mid-race just works: elapsed time since
    // stepsAnchorAt already reflects wherever the race actually is.
    let raceSteps = null;
    let stepsAnchorAt = null;

    // Matches web/src/games/karirs/render.ts's computePlayback() exactly —
    // linearly interpolated between the previous step's positions and the
    // current one, by how far elapsed time is into the current 300ms
    // window (`frac`), not just the raw current-step value. Without this,
    // position only actually changes 3.33 times/second (once per
    // STEP_DELAY_MS) no matter how often the caller polls it — the 2D
    // dots' CSS transition was masking that same staircase, three.js has
    // no equivalent and shows it plainly as a snap every step.
    function currentStepInfo() {
        if (!raceSteps || !stepsAnchorAt) return null;
        const elapsedMs = Math.max(0, Date.now() - stepsAnchorAt);
        const raw = elapsedMs / STEP_DELAY_MS;
        const idx = Math.floor(raw);
        if (idx >= raceSteps.length) {
            const last = raceSteps[raceSteps.length - 1];
            return { positions: last.positions, shouting: last.shouting, step: raceSteps.length, total: raceSteps.length, done: true };
        }
        const frac = raw - idx;
        const prev = idx === 0 ? null : raceSteps[idx - 1].positions;
        const cur = raceSteps[idx];
        const positions = {};
        for (const name of Object.keys(cur.positions)) {
            const p = prev ? prev[name] : 0;
            positions[name] = p + (cur.positions[name] - p) * frac;
        }
        return { positions, shouting: cur.shouting, step: idx + 1, total: raceSteps.length, done: false };
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

    // A second, optional view of the exact same race data the 2D dots
    // above show — see render3d.js. Created once in ensureLayout(), lazily
    // like trackWrapperEl, since it needs the canvas actually attached to
    // the document before creating its WebGL context.
    let scene3dCanvasEl = null;
    let scene3d = null;
    // "chase" (default, matches the web app) / "front" / "overview" —
    // cycled via a button built in ensureLayout(), see cameraToggleBtn.
    let cameraMode = 'chase';
    let cameraToggleBtn = null;

    // Which "phase" of chromeTopEl is currently built (race id + status +
    // whether a bet's been placed + whether an error is showing) — as long
    // as this doesn't change, render() only updates text in place instead of
    // wiping and recreating the racer/Place Bet buttons. Without this, the
    // 200ms animation tick and the 2s pool poll (both of which fire
    // continuously while betting is open) tore the buttons down and rebuilt
    // them out from under an in-progress click, silently dropping it if the
    // rebuild landed between mousedown and mouseup.
    let chromePhaseKey = null;
    let walletLineEl = null;
    let bettingCountdownEl = null;
    let racingTitleEl = null;
    let racerButtonEls = {};
    let racerPoolEls = {};

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
        scene3dCanvasEl = null;
        scene3d = null;
        cameraMode = 'chase';
        cameraToggleBtn = null;
        chromePhaseKey = null;
        walletLineEl = null;
        bettingCountdownEl = null;
        racingTitleEl = null;
        racerButtonEls = {};
        racerPoolEls = {};
        hallOfFame = null;
        showHallOfFame = false;
        hallOfFameVersion = 0;
        render();

        window.CheddarHost.send('sync_race', { lobbyId: ctx.lobbyId });
        window.CheddarHost.send('wallet', {});

        pollTimer = setInterval(poll, 2000);
        // Fast enough to advance the track a step at a time in sync with the
        // server's cadence (see STEP_DELAY_MS) — cheap either way, this is a
        // handful of DOM nodes.
        tickTimer = setInterval(render, 200);
        // The 3D scene needs a much faster, real per-frame loop — see
        // tickScene3d's own comment for why 200ms reads as choppy for
        // WebGL specifically.
        function scene3dFrame() {
            tickScene3d();
            scene3dRafId = requestAnimationFrame(scene3dFrame);
        }
        scene3dRafId = requestAnimationFrame(scene3dFrame);
    }

    function unmount() {
        if (pollTimer) clearInterval(pollTimer);
        if (tickTimer) clearInterval(tickTimer);
        if (scene3dRafId) cancelAnimationFrame(scene3dRafId);
        pollTimer = null;
        tickTimer = null;
        scene3dRafId = null;
        trackWrapperEl = null;
        trackDots = {};
        trackRaceId = null;
        if (scene3d) scene3d.dispose();
        scene3d = null;
        scene3dCanvasEl = null;
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
            const justResolved = race && race.status !== 'resolved' && data.status === 'resolved';
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
            window.CheddarHost.send('wallet', {});
            window.CheddarHost.finishGame();
        } else if (event === 'hall_of_fame') {
            hallOfFame = data;
            hallOfFameVersion += 1;
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
        scene3dCanvasEl = document.createElement('canvas');
        scene3dCanvasEl.style.width = '100%';
        scene3dCanvasEl.style.height = '160px';
        scene3dCanvasEl.style.display = 'block';
        scene3dCanvasEl.style.borderRadius = '4px';
        scene3dCanvasEl.style.marginBottom = '6px';
        cameraToggleBtn = document.createElement('button');
        cameraToggleBtn.type = 'button';
        styleButton(cameraToggleBtn);
        cameraToggleBtn.style.marginBottom = '6px';
        updateCameraToggleLabel();
        cameraToggleBtn.addEventListener('click', () => {
            cameraMode = cameraMode === 'overview' ? 'chase' : cameraMode === 'chase' ? 'front' : 'overview';
            if (scene3d) scene3d.setCameraMode(cameraMode);
            updateCameraToggleLabel();
        });
        trackWrapperEl = document.createElement('div');
        chromeBottomEl = document.createElement('div');
        container.appendChild(chromeTopEl);
        container.appendChild(scene3dCanvasEl);
        container.appendChild(cameraToggleBtn);
        container.appendChild(trackWrapperEl);
        container.appendChild(chromeBottomEl);
        // Created only once the canvas is actually attached to the
        // document — WebGL context creation needs real layout dimensions,
        // which clientWidth/clientHeight (see render3d.js's update()) only
        // report correctly post-attachment.
        scene3d = createKarirsScene3D(scene3dCanvasEl);
        scene3d.setCameraMode(cameraMode);
        trackDots = {};
        trackRaceId = null;
    }

    function updateCameraToggleLabel() {
        if (!cameraToggleBtn) return;
        cameraToggleBtn.textContent =
            cameraMode === 'overview' ? '🎥 Follow leader' : cameraMode === 'chase' ? '🎥 Following (behind)' : '🎥 Following (front)';
    }

    function clearTrack() {
        if (trackWrapperEl) trackWrapperEl.innerHTML = '';
        trackDots = {};
        trackRaceId = null;
    }

    function render() {
        if (!container) return;
        ensureLayout();

        const isRacing = !!race && race.status === 'racing';
        const isResolved = !!race && race.status === 'resolved';
        const isBetting = !!race && !isRacing && !isResolved;
        const stepInfo = isRacing || isResolved ? currentStepInfo() : null;

        // myBet's payout specifically (not just whether myBet exists) has to
        // be part of this key — a bet is placed with payout still null, and
        // the real payout only arrives later via a separate my_bet refetch
        // once the race resolves. Keying on presence alone meant that second
        // update landed on an unchanged key, skipped the rebuild below, and
        // renderResult() (which only runs inside it) never re-ran — so a win
        // could sit there forever still showing the placeholder "no payout
        // this time" from before the real number arrived.
        const myBetPayoutKey = myBet ? (myBet.payout == null ? 'pending' : myBet.payout) : 'none';
        // Same reasoning as myBetPayoutKey above: the Hall of Fame data
        // arrives *after* showHallOfFame already flipped true (the button
        // click and the response are two separate render() calls), so
        // "loaded vs. still pending" has to be part of the key too, or the
        // response landing would skip the rebuild and leave "loading…"
        // on screen forever.
        const hofKey = showHallOfFame ? `hof-${hallOfFameVersion}` : 'hof-closed';
        const phaseKey = `${hofKey}:${!race ? 'loading' : `${race.id}:${race.status}:${myBetPayoutKey}:${!!errorText}`}`;

        if (phaseKey !== chromePhaseKey) {
            chromePhaseKey = phaseKey;
            chromeTopEl.innerHTML = '';
            chromeBottomEl.innerHTML = '';
            racerButtonEls = {};
            racerPoolEls = {};

            walletLineEl = document.createElement('p');
            chromeTopEl.appendChild(walletLineEl);

            const hofBtn = document.createElement('button');
            hofBtn.type = 'button';
            hofBtn.textContent = showHallOfFame ? '✕ Close Hall of Fame' : '🏆 Hall of Fame';
            styleButton(hofBtn);
            hofBtn.style.marginBottom = '6px';
            hofBtn.style.display = 'block';
            hofBtn.addEventListener('click', () => {
                showHallOfFame = !showHallOfFame;
                // Always refetches on open rather than caching indefinitely
                // — this is small, infrequently-changing data, so the cost
                // of asking again is trivial next to showing a stale list.
                // Whatever was already loaded stays visible until the fresh
                // response replaces it, so reopening doesn't flash "loading…"
                // for no reason.
                if (showHallOfFame) {
                    window.CheddarHost.send('hall_of_fame', {});
                }
                render();
            });
            chromeTopEl.appendChild(hofBtn);

            if (showHallOfFame) {
                bettingCountdownEl = null;
                racingTitleEl = null;
                clearTrack();
                renderHallOfFame();
            } else if (!race) {
                bettingCountdownEl = null;
                racingTitleEl = null;
                const p = document.createElement('p');
                p.textContent = 'loading race…';
                chromeTopEl.appendChild(p);
                clearTrack();
            } else if (isBetting) {
                racingTitleEl = null;
                bettingCountdownEl = document.createElement('p');
                chromeTopEl.appendChild(bettingCountdownEl);
                clearTrack();
                renderBetting();
            } else {
                bettingCountdownEl = null;
                racingTitleEl = document.createElement('p');
                chromeTopEl.appendChild(racingTitleEl);
                if (isResolved) renderResult();
            }

            if (errorText) {
                const e = document.createElement('p');
                e.textContent = `⚠ ${errorText}`;
                e.style.color = '#ff8080';
                chromeBottomEl.appendChild(e);
            }
        }

        // Safe to update in place every call, whether or not the phase
        // above just changed — none of this touches the interactive
        // elements themselves, only their text/track positions.
        if (walletLineEl) walletLineEl.textContent = wallet ? `💰 ${wallet.coins} coins` : '💰 …';
        if (bettingCountdownEl) bettingCountdownEl.textContent = `🏇 betting closes in ${secondsLeft()}s`;
        if (isBetting) {
            updateBettingPoolText();
            updateSelectedRacerStyle();
        }
        if (racingTitleEl) {
            racingTitleEl.textContent = isResolved
                ? `🏁 ${race.winning_name} wins!`
                : `🏇 racing… (${stepInfo ? stepInfo.step : 0}/${stepInfo ? stepInfo.total : 0})`;
        }
        if (isRacing && stepInfo && !showHallOfFame) {
            ensureTrackDom();
            updateTrackDots(stepInfo.positions, stepInfo.shouting);
        }
        if (scene3dCanvasEl) {
            // Just the show/hide toggle here — the actual per-frame
            // scene3d.update() call is driven by its own requestAnimationFrame
            // loop (see tickScene3d/mount), not this 200ms tick. Three.js has
            // no CSS-transition-style smoothing between renders the way the
            // 2D dots above do, so updating it only 5x/second reads as
            // visibly choppy no matter how good the scene itself is.
            const showScene3d = isRacing && !!stepInfo && !showHallOfFame;
            scene3dCanvasEl.style.display = showScene3d ? 'block' : 'none';
        }
    }

    // Driven by its own requestAnimationFrame loop (see mount/unmount),
    // independent of render()'s 200ms tick — recomputes stepInfo fresh each
    // frame off the module-level race/myBet/showHallOfFame state rather
    // than trusting anything render() last computed, same reasoning the
    // web app's own draw() loop uses (always reads off a ref, never a
    // stale closure value).
    function tickScene3d() {
        if (!scene3dCanvasEl || !scene3d || !race) return;
        const isRacing = race.status === 'racing';
        const isResolved = race.status === 'resolved';
        const stepInfo = isRacing || isResolved ? currentStepInfo() : null;
        if (!isRacing || !stepInfo || showHallOfFame) return;
        scene3d.update({
            racerNames: race.racer_names,
            playback: { positions: stepInfo.positions, shouting: stepInfo.shouting },
            winningName: race.winning_name,
            isResolved,
            myBetRacerName: myBet ? myBet.racer_name : null,
            faceImageUrls: race.face_image_urls ?? {},
            signatureMoves: race.signature_moves ?? {},
        });
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

            // Signature-move callout — shown only while shouting.includes(name)
            // (see race.py's PEAK_SPEED_THRESHOLD), positioned above the dot.
            // No transition on this one: it should snap in/out with the
            // step, not visibly slide around like the dot does.
            const shout = document.createElement('span');
            shout.style.position = 'absolute';
            shout.style.bottom = '100%';
            shout.style.left = '0%';
            shout.style.transform = 'translateX(-50%)';
            shout.style.marginBottom = '2px';
            shout.style.background = '#3a2a06';
            shout.style.color = '#ffd76a';
            shout.style.border = '1px solid #d97706';
            shout.style.borderRadius = '6px';
            shout.style.padding = '1px 5px';
            shout.style.fontSize = '8px';
            shout.style.whiteSpace = 'nowrap';
            shout.style.display = 'none';
            lane.appendChild(shout);

            row.appendChild(lane);

            trackWrapperEl.appendChild(row);
            trackDots[name] = { label, dot, shout };
        });
    }

    // Only mutates the existing dots/labels built above — this is what
    // actually lets the CSS transition on `left` animate smoothly.
    function updateTrackDots(positions, shouting) {
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

            if (shouting && shouting.includes(name)) {
                const moves = race.signature_moves || {};
                els.shout.textContent = moves[name] || `${name}'s Signature Move!`;
                els.shout.style.left = `${pct}%`;
                els.shout.style.display = 'inline-block';
            } else {
                els.shout.style.display = 'none';
            }
        });
    }

    // Darker than the default browser control chrome (which stood out badly
    // against the app's dark theme) — solid, not the old semi-transparent
    // wash, so the buttons read clearly against the panel background.
    function styleButton(el) {
        el.style.background = '#2c2c2ce6';
        el.style.color = '#ffffffdd';
        el.style.border = 'unset';
        el.style.padding = '4px 12px';
    }

    function styleInput(el) {
        el.style.background = '#2c2c2ce6';
        el.style.color = '#ffffffcc';
        el.style.border = 'unset';
        el.style.padding = '4px 6px';
    }

    // The amber outline standing in for the old "▶ " text marker — an
    // outline (not a border) so toggling it never shifts the button's size
    // or the layout around it.
    function updateSelectedRacerStyle() {
        Object.keys(racerButtonEls).forEach((name) => {
            racerButtonEls[name].style.outline = name === selectedRacer ? '2px solid #d9a441' : 'unset';
        });
    }

    // Pool totals refresh every 2s while betting is open — updates each
    // row's count in place rather than through renderBetting's full rebuild,
    // which runs only once per race/bet-state (see render()'s phaseKey).
    function updateBettingPoolText() {
        if (!pool) return;
        Object.keys(racerPoolEls).forEach((name) => {
            racerPoolEls[name].textContent = String(pool[name] ?? 0);
        });
    }

    function renderBetting() {
        const list = document.createElement('div');
        list.style.display = 'flex';
        list.style.flexDirection = 'column';
        list.style.gap = '6px';
        list.style.marginBottom = '10px';

        race.racer_names.forEach((name) => {
            const total = pool ? (pool[name] ?? 0) : 0;
            // Frozen the moment betting opened (see karirs' roster.compute_payout_multipliers)
            // — a racer with a stronger overall win/loss record pays less, a longshot pays more.
            const multiplier = race.payout_multipliers ? race.payout_multipliers[name] : null;
            const odds = multiplier != null ? ` — ${multiplier.toFixed(2)}x payout` : '';

            if (myBet) {
                const label = document.createElement('span');
                label.textContent = `${name === myBet.racer_name ? '★ ' : ''}${name}${odds} — pool: `;
                const poolSpan = document.createElement('span');
                poolSpan.textContent = String(total);
                label.appendChild(poolSpan);
                racerPoolEls[name] = poolSpan;
                list.appendChild(label);
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.style.display = 'block';
                btn.style.width = '100%';
                btn.style.textAlign = 'left';
                styleButton(btn);

                const textSpan = document.createElement('span');
                textSpan.textContent = `${name}${odds} — pool: `;
                const poolSpan = document.createElement('span');
                poolSpan.textContent = String(total);
                btn.appendChild(textSpan);
                btn.appendChild(poolSpan);

                racerButtonEls[name] = btn;
                racerPoolEls[name] = poolSpan;
                btn.addEventListener('click', () => {
                    selectedRacer = name;
                    render();
                });
                list.appendChild(btn);
            }
        });
        chromeTopEl.appendChild(list);
        updateSelectedRacerStyle();

        if (myBet) {
            const p = document.createElement('p');
            p.textContent = '✅ bet placed — check the game chat for the announcement';
            chromeTopEl.appendChild(p);
            return;
        }

        const controlsRow = document.createElement('div');
        controlsRow.style.display = 'flex';
        controlsRow.style.gap = '8px';
        controlsRow.style.marginTop = '4px';

        const wagerInput = document.createElement('input');
        wagerInput.type = 'number';
        wagerInput.min = '1';
        wagerInput.value = '50';
        wagerInput.style.width = '70px';
        styleInput(wagerInput);
        controlsRow.appendChild(wagerInput);

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
        controlsRow.appendChild(betBtn);
        chromeTopEl.appendChild(controlsRow);
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

    // The 10 biggest wagers that ever actually won, ranked by wager size
    // (not payout) — fetched on demand (see the Hall of Fame button in
    // render()), not kept live.
    function renderHallOfFame() {
        const hint = document.createElement('p');
        hint.textContent = 'The biggest bets that ever actually won.';
        hint.style.opacity = '0.7';
        chromeTopEl.appendChild(hint);

        if (!hallOfFame) {
            const p = document.createElement('p');
            p.textContent = 'loading…';
            chromeTopEl.appendChild(p);
            return;
        }
        if (hallOfFame.length === 0) {
            const p = document.createElement('p');
            p.textContent = 'no winning bets yet';
            chromeTopEl.appendChild(p);
            return;
        }
        hallOfFame.forEach((entry, i) => {
            const p = document.createElement('p');
            p.textContent = `#${i + 1} ${entry.display_name} bet ${entry.wager} on ${entry.racer_name} — +${entry.payout}`;
            chromeTopEl.appendChild(p);
        });
    }

    window.CheddarGames = window.CheddarGames || {};
    window.CheddarGames['karirs'] = { mount, unmount, onEvent };
})();
