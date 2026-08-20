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
const chatTitleEl = document.getElementById('chat-title');
const gameStageEl = document.getElementById('game-stage');

// So the "rejoin" button's click handler can mount the right game without a
// round trip to the host — renderLobby() already gets everything it needs.
let lastLobby = null;
let lastSelfId = null;

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
        renderLobby(msg.data, msg.selfId);
    }
    else if (msg.type === 'chat.title') {
        chatTitleEl.textContent = msg.text ?? '';
        chatTitleEl.title = msg.text ?? '';
    }
    else if (msg.type === 'game.mount') {
        mountGame(msg);
    }
    else if (msg.type === 'game.event') {
        const game = window.CheddarGames && window.CheddarGames[msg.gameKey];
        if (game && game.onEvent) game.onEvent(msg.event, msg.data);
    }
});

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

function renderLobby(lobby, selfId) {
    lastLobby = lobby;
    lastSelfId = selfId;

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
    lobbyReadyBtn.style.display = gameLive ? 'none' : 'inline-block';
    lobbyReadyBtn.textContent = me?.is_ready ? 'Unready' : 'Ready';
    lobbyStartBtn.style.display = isLeader && !gameLive ? 'inline-block' : 'none';
    lobbyStartBtn.disabled = !allReady;
    lobbyHintEl.textContent = gameLive
        ? ''
        : isLeader
            ? (allReady ? 'all ready — Start when you are' : 'waiting for everyone to ready up')
            : '/lobby invite <username> to add a friend';

    lobbyRestartBtn.style.display = isLeader && gameLive ? 'inline-block' : 'none';
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
        vscode.postMessage({ type: 'game', action: 'start' });
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
        renderLobby(lastLobby, lastSelfId);
    }
    else if (e.target.id === 'game-drawer-lock') {
        const isUnlocked = msgEl.classList.contains('unlocked');

        if (isUnlocked) {
            msgEl.classList.remove('unlocked');
        } else {
            msgEl.classList.add('unlocked');
        }
    }
});