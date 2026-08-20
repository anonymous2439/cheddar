// Karirs — a Philippine "karera" (video horse-racing betting) style game.
// Racers are a fixed roster the Karirs API deals out itself (not the lobby's
// players), betting is anonymous (only aggregate pool totals are visible),
// and the race resolves on its own 30s after it's created — there's no
// "start"/"resolve" action here at all, just polling for state to change.
(function () {
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

    function mount(el, mountCtx) {
        container = el;
        ctx = mountCtx;
        wallet = null;
        race = null;
        pool = null;
        myBet = null;
        selectedRacer = null;
        errorText = '';
        render();

        window.CheddarHost.send('sync_race', { lobbyId: ctx.lobbyId });
        window.CheddarHost.send('wallet', {});

        pollTimer = setInterval(poll, 2000);
        tickTimer = setInterval(render, 1000);
    }

    function unmount() {
        if (pollTimer) clearInterval(pollTimer);
        if (tickTimer) clearInterval(tickTimer);
        pollTimer = null;
        tickTimer = null;
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

            if (isFirstLoad || justResolved) {
                window.CheddarHost.send('pool', { raceId: race.id });
                window.CheddarHost.send('my_bet', { raceId: race.id });
            }
            if (justResolved && pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
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

    function render() {
        if (!container) return;
        container.innerHTML = '';

        const walletLine = document.createElement('p');
        walletLine.textContent = wallet ? `💰 ${wallet.coins} coins` : '💰 …';
        container.appendChild(walletLine);

        if (!race) {
            const p = document.createElement('p');
            p.textContent = 'loading race…';
            container.appendChild(p);
            return;
        }

        if (race.status === 'betting_open') {
            const title = document.createElement('p');
            title.textContent = `🏇 betting closes in ${secondsLeft()}s`;
            container.appendChild(title);
            renderBetting();
        } else {
            const title = document.createElement('p');
            title.textContent = `🏁 ${race.winning_name} wins!`;
            container.appendChild(title);
            renderResolved();
        }

        if (errorText) {
            const e = document.createElement('p');
            e.textContent = `⚠ ${errorText}`;
            e.style.color = '#ff8080';
            container.appendChild(e);
        }
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
                btn.addEventListener('click', () => {
                    selectedRacer = name;
                    render();
                });
                row.appendChild(btn);
            }
            list.appendChild(row);
        });
        container.appendChild(list);

        if (myBet) {
            const p = document.createElement('p');
            p.textContent = `you bet ${myBet.wager} coins on ${myBet.racer_name} — nobody else can see that`;
            container.appendChild(p);
            return;
        }

        const wagerInput = document.createElement('input');
        wagerInput.type = 'number';
        wagerInput.min = '1';
        wagerInput.value = '50';
        wagerInput.style.width = '70px';
        container.appendChild(wagerInput);

        const betBtn = document.createElement('button');
        betBtn.type = 'button';
        betBtn.textContent = 'Place Bet';
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
        container.appendChild(betBtn);
    }

    function renderResolved() {
        const list = document.createElement('div');
        race.racer_names.forEach((name) => {
            const total = pool ? (pool[name] ?? 0) : 0;
            const p = document.createElement('p');
            const won = name === race.winning_name;
            p.textContent = `${won ? '🏆 ' : ''}${name} — pool: ${total}`;
            list.appendChild(p);
        });
        container.appendChild(list);

        if (myBet) {
            const p = document.createElement('p');
            p.textContent =
                myBet.payout > 0
                    ? `you bet on ${myBet.racer_name} and won ${myBet.payout} coins!`
                    : `you bet ${myBet.wager} on ${myBet.racer_name} — no payout this time.`;
            container.appendChild(p);
        }
    }

    window.CheddarGames = window.CheddarGames || {};
    window.CheddarGames['karirs'] = { mount, unmount, onEvent };
})();
