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
const lobbyHintEl = document.getElementById('lobby-hint');
const chatTitleEl = document.getElementById('chat-title');

// Receive messages from extension
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'log') {
        const p = document.createElement('p');
        p.textContent = msg.text;
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
});

function renderCatalog(games) {
    gameCatalogEl.innerHTML = '';
    games.forEach((g, i) => {
        const li = document.createElement('li');
        li.textContent = `${i + 1}) ${g.name} (${g.min_players}-${g.max_players})`;
        gameCatalogEl.appendChild(li);
    });
}

function renderLobby(lobby, selfId) {
    if (!lobby) {
        lobbyViewEl.style.display = 'none';
        gameHintEl.style.display = 'block';
        return;
    }

    gameHintEl.style.display = 'none';
    lobbyViewEl.style.display = 'block';
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
    else if (e.target.id === 'game-drawer-lock') {
        const isUnlocked = msgEl.classList.contains('unlocked');

        if (isUnlocked) {
            msgEl.classList.remove('unlocked');
        } else {
            msgEl.classList.add('unlocked');
        }
    }
});