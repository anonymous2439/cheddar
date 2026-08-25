const vscode = acquireVsCodeApi();
const textbox = document.getElementById('textbox');
const msgContainer = document.getElementById('msg-users');
const msgContent = document.getElementById('msg-content');
const msgEl = document.getElementById('msg');

const gameCatalogEl = document.getElementById('game-catalog');
const gameHintEl = document.getElementById('game-hint');
const lobbyViewEl = document.getElementById('lobby-view');
const lobbyTitleEl = document.getElementById('lobby-title');
const lobbyPlayersEl = document.getElementById('lobby-players');
const lobbyReadyBtn = document.getElementById('lobby-ready');
const lobbyStartBtn = document.getElementById('lobby-start');
const lobbyLeaveBtn = document.getElementById('lobby-leave');
const lobbyRestartBtn = document.getElementById('lobby-restart');
const lobbyRejoinBtn = document.getElementById('lobby-rejoin');
const lobbyInviteBtn = document.getElementById('lobby-invite-btn');
const lobbyInviteRow = document.getElementById('lobby-invite-row');
const lobbyInviteInput = document.getElementById('lobby-invite-input');
const lobbyInviteSendBtn = document.getElementById('lobby-invite-send');
const lobbyHintEl = document.getElementById('lobby-hint');
const lobbyBeatsConfigEl = document.getElementById('lobby-beats-config');
const beatsModeSelect = document.getElementById('beats-mode');
const beatsBpmSelect = document.getElementById('beats-bpm');
const beatsPulseCountSelect = document.getElementById('beats-pulse-count');
const chatTitleEl = document.getElementById('chat-title');
const gameStageEl = document.getElementById('game-stage');

const replayViewEl = document.getElementById('replay-view');
const replayTrackEl = document.getElementById('replay-track');
const replayStatusEl = document.getElementById('replay-status');
const replayStandingsEl = document.getElementById('replay-standings');
const replayAgainBtn = document.getElementById('replay-again');

// So the "rejoin" button's click handler can mount the right game without a
// round trip to the host — renderLobby() already gets everything it needs.
let lastLobby = null;
let lastSelfId = null;
let lastTracksCompletion = false;

// The most recently clicked "Claim 250 coins" button — only one claim can
// realistically be in flight at a time, so tracking just the last one is
// enough to update it once the host's response comes back.
let pendingDailyBonusBtn = null;

// Receive messages from extension
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'log') {
        const p = document.createElement('p');
        p.textContent = msg.text;
        msgContent.appendChild(p);
        msgContainer.scrollTop = msgContainer.scrollHeight;
    }
    else if (msg.type === 'log.invite') {
        const p = document.createElement('p');
        p.textContent = msg.text + ' — ';
        const joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.textContent = 'Join';
        joinBtn.style.background = '#c4c4c454';
        joinBtn.style.color = '#ffffffaa';
        joinBtn.style.border = 'unset';
        joinBtn.style.padding = '0px 8px';
        joinBtn.style.fontSize = 'inherit';
        joinBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'game', action: 'resume_lobby', lobbyId: msg.lobbyId });
        });
        p.appendChild(joinBtn);
        msgContent.appendChild(p);
        msgContainer.scrollTop = msgContainer.scrollHeight;
    }
    else if (msg.type === 'catalog.render') {
        renderCatalog(msg.data ?? []);
    }
    else if (msg.type === 'lobby.render') {
        renderLobby(msg.data, msg.selfId, msg.tracksCompletion);
    }
    else if (msg.type === 'chat.title') {
        chatTitleEl.textContent = msg.text ?? '';
        chatTitleEl.title = msg.text ?? '';
    }
    else if (msg.type === 'game.mount') {
        mountGame(msg);
    }
    else if (msg.type === 'log.replay') {
        const p = document.createElement('p');
        p.textContent = msg.text + ' — ';
        const replayBtn = document.createElement('button');
        replayBtn.type = 'button';
        replayBtn.textContent = 'Watch Replay';
        replayBtn.style.background = '#c4c4c454';
        replayBtn.style.color = '#ffffffaa';
        replayBtn.style.border = 'unset';
        replayBtn.style.padding = '0px 8px';
        replayBtn.style.fontSize = 'inherit';
        replayBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'game.action', gameKey: 'karirs', action: 'view_replay', data: { raceId: msg.raceId } });
        });
        p.appendChild(replayBtn);
        msgContent.appendChild(p);
        msgContainer.scrollTop = msgContainer.scrollHeight;
    }
    else if (msg.type === 'log.daily_bonus') {
        const p = document.createElement('p');
        p.textContent = msg.text + ' — ';
        const claimBtn = document.createElement('button');
        claimBtn.type = 'button';
        claimBtn.textContent = 'Claim 250 coins';
        claimBtn.style.background = '#c4c4c454';
        claimBtn.style.color = '#ffffffaa';
        claimBtn.style.border = 'unset';
        claimBtn.style.padding = '0px 8px';
        claimBtn.style.fontSize = 'inherit';
        claimBtn.addEventListener('click', () => {
            claimBtn.disabled = true;
            claimBtn.textContent = 'Claiming…';
            pendingDailyBonusBtn = claimBtn;
            vscode.postMessage({ type: 'game.action', gameKey: 'karirs', action: 'claim_daily_bonus', data: {} });
        });
        p.appendChild(claimBtn);
        msgContent.appendChild(p);
        msgContainer.scrollTop = msgContainer.scrollHeight;
    }
    else if (msg.type === 'game.event') {
        // A replay is watchable straight from chat whether or not any karirs
        // game module happens to be mounted right now — it renders into its
        // own dedicated panel below, never through the game module.
        if (msg.event === 'replay_data') {
            renderReplay(msg.data);
        } else if (msg.event === 'daily_bonus_claimed') {
            if (pendingDailyBonusBtn) {
                pendingDailyBonusBtn.textContent = '✅ Claimed!';
                pendingDailyBonusBtn = null;
            }
        } else if (msg.event === 'daily_bonus_claim_conflict') {
            if (pendingDailyBonusBtn) {
                pendingDailyBonusBtn.textContent = '✅ Already claimed';
                pendingDailyBonusBtn = null;
            }
        } else {
            if (msg.event === 'error' && replayViewEl.style.display === 'block' && !replayRace) {
                replayStatusEl.textContent = `⚠ ${msg.data.message}`;
            }
            if (msg.event === 'error' && pendingDailyBonusBtn) {
                pendingDailyBonusBtn.disabled = false;
                pendingDailyBonusBtn.textContent = "Couldn't claim — try again";
                pendingDailyBonusBtn = null;
            }
            const game = window.CheddarGames && window.CheddarGames[msg.gameKey];
            if (game && game.onEvent) game.onEvent(msg.event, msg.data);
        }
    }
});

// -----------------------------
// 🔹 Race replay — a one-off playback of a past, already-resolved race,
// reachable straight from a "watch a replay" chat message. Lives in the host
// chrome (not the karirs game module) since it's watchable with no active
// game session at all. Same lane/dot visual language as the live game for
// consistency, but its own small self-contained renderer: no betting, no
// wallet, just "replay this exact race" driven by a local anchor timestamp
// instead of the race's real betting_closes_at.
// -----------------------------
const REPLAY_STEP_DELAY_MS = 300;

let replayRace = null;
let replayPool = null;
let replayAnchorAt = 0;
let replayTickTimer = null;
let replayDots = {};

function replayStepInfo() {
    if (!replayRace || !replayRace.steps || !replayRace.steps.length) return null;
    const steps = replayRace.steps;
    const elapsed = Math.max(0, Date.now() - replayAnchorAt);
    const idx = Math.floor(elapsed / REPLAY_STEP_DELAY_MS);
    if (idx >= steps.length) {
        const last = steps[steps.length - 1];
        return { positions: last.positions, shouting: last.shouting, step: steps.length, total: steps.length, done: true };
    }
    const cur = steps[idx];
    return { positions: cur.positions, shouting: cur.shouting, step: idx + 1, total: steps.length, done: false };
}

function ensureReplayTrackDom() {
    replayTrackEl.innerHTML = '';
    replayDots = {};
    replayRace.racer_names.forEach((name) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '6px';
        row.style.margin = '3px 0';

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

        replayTrackEl.appendChild(row);
        replayDots[name] = { label, dot, shout };
    });
}

function updateReplayView() {
    const info = replayStepInfo();
    if (!info) return;

    replayRace.racer_names.forEach((name) => {
        const els = replayDots[name];
        if (!els) return;
        const isWinner = name === replayRace.winning_name;
        const pct = Math.max(0, Math.min(100, info.positions[name] ?? 0));
        els.label.textContent = `${name}${isWinner ? ' 🏆' : ''}`;
        els.label.style.color = isWinner ? '#ffd76a' : '#ffffffcc';
        els.dot.style.left = `${pct}%`;
        els.dot.style.background = isWinner ? '#ffd76a' : '#0080BAc4';

        if (info.shouting && info.shouting.includes(name)) {
            const moves = replayRace.signature_moves || {};
            els.shout.textContent = moves[name] || `${name}'s Signature Move!`;
            els.shout.style.left = `${pct}%`;
            els.shout.style.display = 'inline-block';
        } else {
            els.shout.style.display = 'none';
        }
    });

    replayStatusEl.textContent = info.done ? `🏁 ${replayRace.winning_name} won!` : `racing… (${info.step}/${info.total})`;

    replayStandingsEl.innerHTML = '';
    replayRace.racer_names.forEach((name) => {
        const li = document.createElement('li');
        const total = replayPool ? (replayPool[name] ?? 0) : 0;
        li.textContent = `${name === replayRace.winning_name ? '🏆 ' : ''}${name} — pool: ${total}`;
        replayStandingsEl.appendChild(li);
    });

    replayAgainBtn.style.display = info.done ? 'inline-block' : 'none';
}

function renderReplay(data) {
    replayRace = data.race;
    replayPool = data.pool;
    replayAnchorAt = Date.now();
    replayViewEl.style.display = 'block';
    ensureReplayTrackDom();
    if (replayTickTimer) clearInterval(replayTickTimer);
    replayTickTimer = setInterval(updateReplayView, 200);
    updateReplayView();
}

function closeReplay() {
    if (replayTickTimer) clearInterval(replayTickTimer);
    replayTickTimer = null;
    replayViewEl.style.display = 'none';
    replayRace = null;
    replayPool = null;
}

// Bridge for a mounted game module to reach the extension host — the host
// holds the access token and does the actual fetch, the module never talks
// to a game's API directly. Replies come back as 'game.event' above, routed
// to whichever module is currently mounted.
window.CheddarHost = {
    send(action, data) {
        const gameKey = gameStageEl.dataset.mountedKey;
        if (!gameKey) return;
        vscode.postMessage({ type: 'game.action', gameKey, action, data });
    },
    // Lobby-level, not game-API-level — tells Cheddar itself (not the game's
    // own backend) that this game's session has concluded, so the leader's
    // "Back to Lobby" unblocks. Idempotent server-side.
    finishGame() {
        vscode.postMessage({ type: 'game', action: 'finish' });
    },
};

function mountGame(msg) {
    const game = window.CheddarGames && window.CheddarGames[msg.gameKey];
    if (!game) {
        console.error(`no vendored module for game "${msg.gameKey}" — was vendor-games.sh run before packaging?`);
        return;
    }
    gameStageEl.style.display = 'block';
    gameStageEl.dataset.mountedKey = msg.gameKey;
    game.mount(gameStageEl, {
        gameKey: msg.gameKey,
        gameName: msg.gameName,
        lobbyId: msg.lobbyId,
        selfId: msg.selfId,
        leaderId: msg.leaderId,
        participants: msg.participants ?? [],
    });
}

function unmountGame() {
    if (gameStageEl.style.display === 'none') return;
    const key = gameStageEl.dataset.mountedKey;
    const game = key && window.CheddarGames && window.CheddarGames[key];
    if (game) game.unmount(gameStageEl);
    gameStageEl.style.display = 'none';
    delete gameStageEl.dataset.mountedKey;
}

function renderCatalog(games) {
    gameCatalogEl.innerHTML = '';
    games.forEach((g, i) => {
        const li = document.createElement('li');
        li.textContent = `${i + 1}) ${g.name} (${g.min_players}-${g.max_players})`;
        gameCatalogEl.appendChild(li);
    });
}

function renderLobby(lobby, selfId, tracksCompletion) {
    lastLobby = lobby;
    lastSelfId = selfId;
    lastTracksCompletion = tracksCompletion;

    if (!lobby) {
        lobbyViewEl.style.display = 'none';
        lobbyRestartBtn.style.display = 'none';
        lobbyRejoinBtn.style.display = 'none';
        lobbyInviteRow.style.display = 'none';
        gameHintEl.style.display = 'block';
        unmountGame();
        return;
    }

    gameHintEl.style.display = 'none';
    gameCatalogEl.innerHTML = '';
    lobbyViewEl.style.display = 'block';
    if (lobby.status === 'waiting') {
        unmountGame();
    }
    lobbyTitleEl.textContent = `${lobby.game_name} — ${lobby.status}`;

    const me = lobby.participants.find(p => p.user.id === selfId);
    const isLeader = !!me?.is_leader;
    const allReady = lobby.participants.length > 0 && lobby.participants.every(p => p.is_ready);

    lobbyPlayersEl.innerHTML = '';
    lobby.participants.forEach(p => {
        const li = document.createElement('li');
        const crown = p.is_leader ? '👑 ' : '';
        const ready = p.is_ready ? '✓ ready' : '… not ready';
        li.textContent = `${crown}@${p.user.username} — ${ready}`;
        lobbyPlayersEl.appendChild(li);
    });

    const gameLive = lobby.status !== 'waiting';
    const isOngoing = lobby.status === 'in_progress' && tracksCompletion;
    lobbyReadyBtn.style.display = gameLive ? 'none' : 'inline-block';
    lobbyReadyBtn.textContent = me?.is_ready ? 'Unready' : 'Ready';
    lobbyStartBtn.style.display = isLeader && !gameLive ? 'inline-block' : 'none';
    lobbyStartBtn.disabled = !allReady;
    lobbyBeatsConfigEl.style.display = isLeader && !gameLive && lobby.game_key === 'cheddar_beats' ? 'block' : 'none';
    lobbyHintEl.textContent = isOngoing
        ? '🎮 game in progress — invites disabled until it finishes'
        : gameLive
            ? ''
            : isLeader
                ? (allReady ? 'all ready — Start when you are' : 'waiting for everyone to ready up')
                : '/lobby invite <username> to add a friend';

    lobbyRestartBtn.style.display = isLeader && gameLive && !isOngoing ? 'inline-block' : 'none';
    lobbyInviteBtn.style.display = gameLive ? 'none' : 'inline-block';
    if (gameLive) lobbyInviteRow.style.display = 'none';

    // A game session is live but this client never mounted it (joined after
    // it started, or reconnected) — the ready/start controls are already
    // hidden above, so without this the panel would just show an empty
    // player list with no way back into what's actually happening.
    const gameShowingThisLobby =
        gameStageEl.style.display === 'block' && gameStageEl.dataset.mountedKey === lobby.game_key;
    lobbyRejoinBtn.style.display = gameLive && !gameShowingThisLobby ? 'inline-block' : 'none';
}

// Send the typed line to the extension host on Enter. The host owns all the
// parsing (slash-commands vs. a plain chat send) and network calls — the
// webview just relays raw input and renders whatever log lines come back.
textbox.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const text = textbox.value.trim();
        if (!text) return;

        vscode.postMessage({ type: 'input', text });
        textbox.value = '';
    }
});

function sendLobbyInvite() {
    const username = lobbyInviteInput.value.trim();
    if (!username) return;
    vscode.postMessage({ type: 'game', action: 'invite', username });
    lobbyInviteInput.value = '';
    lobbyInviteRow.style.display = 'none';
}

lobbyInviteInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendLobbyInvite();
    }
});


window.addEventListener('click', (e) => {
    if (e.target.id === 'lobby-ready') {
        vscode.postMessage({ type: 'game', action: 'ready' });
    }
    else if (e.target.id === 'lobby-start') {
        const isBeats = lastLobby && lastLobby.game_key === 'cheddar_beats';
        vscode.postMessage({
            type: 'game',
            action: 'start',
            beatsMode: isBeats ? beatsModeSelect.value : undefined,
            beatsBpm: isBeats ? Number(beatsBpmSelect.value) : undefined,
            beatsPulseCount: isBeats ? Number(beatsPulseCountSelect.value) : undefined,
        });
    }
    else if (e.target.id === 'lobby-leave') {
        vscode.postMessage({ type: 'game', action: 'leave' });
    }
    else if (e.target.id === 'lobby-restart') {
        vscode.postMessage({ type: 'game', action: 'restart' });
    }
    else if (e.target.id === 'lobby-invite-btn') {
        const isHidden = lobbyInviteRow.style.display === 'none';
        lobbyInviteRow.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) lobbyInviteInput.focus();
    }
    else if (e.target.id === 'lobby-invite-send') {
        sendLobbyInvite();
    }
    else if (e.target.id === 'lobby-rejoin') {
        if (!lastLobby) return;
        mountGame({
            gameKey: lastLobby.game_key,
            gameName: lastLobby.game_name,
            lobbyId: lastLobby.id,
            selfId: lastSelfId,
            leaderId: lastLobby.leader_id,
            participants: lastLobby.participants.map(p => p.user),
        });
        renderLobby(lastLobby, lastSelfId, lastTracksCompletion);
    }
    else if (e.target.id === 'game-drawer-lock') {
        const isUnlocked = msgEl.classList.contains('unlocked');

        if (isUnlocked) {
            msgEl.classList.remove('unlocked');
        } else {
            msgEl.classList.add('unlocked');
        }
    }
    else if (e.target.id === 'replay-close') {
        closeReplay();
    }
    else if (e.target.id === 'replay-again') {
        replayAnchorAt = Date.now();
    }
});