const vscode = acquireVsCodeApi();
// Correlates CheddarHost.getAccessToken() calls to their async reply (see
// the 'game.accessToken' handler below) — a plain fire-and-forget
// send()/onEvent() pair doesn't fit a "give me a value back" request.
let nextTokenRequestId = 1;
const pendingTokenRequests = new Map();
// Same request/response correlation idea as pendingTokenRequests, for
// Glophimon's own wild-engage race check (see enterGlophimon's own
// onEngageWild) — engaging must be awaited (unlike catch/release/claim,
// which are fire-and-forget) so the battle only actually starts once the
// server confirms nobody else got there first.
let nextGlophimonWildRequestId = 1;
const pendingGlophimonWildRequests = new Map();
// Same idea again, for the Karirs field's own state fetch/bet/claim —
// each needs a real result back (the current race+bet/whether the bet
// was accepted/the claimed amount) to update the popup correctly.
let nextKarirsRequestId = 1;
const pendingKarirsRequests = new Map();
// Jared's shop (see game.js's own ctx.onShopBuy) — same awaited-result
// idea, its own requestId/Map so it never collides with a Karirs one.
let nextShopRequestId = 1;
const pendingShopRequests = new Map();
// EXP/leveling (see game.js's own ctx.onBattleResult) — the battle log
// needs the real per-participant EXP/level-up numbers back before it can
// announce anything, same awaited shape as the others above.
let nextBattleRequestId = 1;
const pendingBattleRequests = new Map();
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
const lobbyChessAiConfigEl = document.getElementById('lobby-chess-ai-config');
const chessAiSkillSelect = document.getElementById('chess-ai-skill');
const lobbyChessColorConfigEl = document.getElementById('lobby-chess-color-config');
const chessColorSelect = document.getElementById('chess-color-preference');
const lobbyLubaConfigEl = document.getElementById('lobby-luba-config');
const lubaDurationMinutesSelect = document.getElementById('luba-duration-minutes');
const lobbyLubaPracticeBtn = document.getElementById('lobby-luba-practice');
const lobbyLubaPracticeExitBtn = document.getElementById('lobby-luba-practice-exit');
const lubaReturnToGlophimonBtn = document.getElementById('luba-return-to-glophimon');
const chatTitleEl = document.getElementById('chat-title');
const gameStageEl = document.getElementById('game-stage');

const replayViewEl = document.getElementById('replay-view');
const replayTrackEl = document.getElementById('replay-track');
const replayStatusEl = document.getElementById('replay-status');
const replayStandingsEl = document.getElementById('replay-standings');
const replayAgainBtn = document.getElementById('replay-again');

const glsimsWorldHomeEl = document.getElementById('glsimsworld-home');
const glsimsWorldRosterEl = document.getElementById('glsimsworld-roster');
const glsimsWorldRefreshBtn = document.getElementById('glsimsworld-refresh');
const glsimsWorldLeaveBtn = document.getElementById('glsimsworld-leave');

const glophimonCreateEl = document.getElementById('glophimon-create');
const glophimonPreviewEl = document.getElementById('glophimon-preview');
const glophimonNameInput = document.getElementById('glophimon-name');
const glophimonHeadColorInput = document.getElementById('glophimon-head-color');
const glophimonBodyColorInput = document.getElementById('glophimon-body-color');
const glophimonArmColorInput = document.getElementById('glophimon-arm-color');
const glophimonLegColorInput = document.getElementById('glophimon-leg-color');
const glophimonGenderSelect = document.getElementById('glophimon-gender');
const glophimonCreateSubmitBtn = document.getElementById('glophimon-create-submit');
const glophimonStarterEl = document.getElementById('glophimon-starter');
const glophimonStarterPreviewEl = document.getElementById('glophimon-starter-preview');
const glophimonStarterListEl = document.getElementById('glophimon-starter-list');
const glophimonStarterSubmitBtn = document.getElementById('glophimon-starter-submit');

// So the "rejoin" button's click handler can mount the right game without a
// round trip to the host — renderLobby() already gets everything it needs.
let lastLobby = null;
let lastSelfId = null;
let lastTracksCompletion = false;
// Luba's practice sandbox is fully local (no lobby state touched at all —
// see mountPractice) — while active, it owns gameStageEl entirely and
// renderLobby() must not re-show the normal lobby view or call
// unmountGame() out from under it just because the underlying lobby is
// still (and stays) "waiting".
let lubaPracticeActive = false;
// Same reasoning as lubaPracticeActive — GL Sims World also owns
// gameStageEl outside of any real lobby (see enterGlSimsWorld/
// exitGlSimsWorld below), so renderLobby() must not clobber it either.
let glsimsWorldActive = false;
// Same reasoning again — Glophimon also owns gameStageEl (and, while the
// one-time creation form is showing, the view entirely) outside of any
// real lobby (see enterGlophimon/exitGlophimon below).
let glophimonActive = false;
// A Luba match hosted from inside Glophimon's own world (see
// onLubaMatchReady below) — same "owns gameStageEl outside of any real
// lobby" reasoning as the three flags above, plus there's no real Cheddar
// game_lobbies row backing this match at all for renderLobby() to even
// find.
let lubaFromGlophimon = false;

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
    else if (msg.type === 'glsimsworld.render') {
        renderGlSimsWorldRoster(msg.data ?? []);
    }
    else if (msg.type === 'glsimsworld.mount') {
        enterGlSimsWorld(msg.racer, msg.displayName);
    }
    else if (msg.type === 'glophimon.create') {
        showGlophimonCreate();
    }
    else if (msg.type === 'glophimon.chooseStarter') {
        showGlophimonStarterPicker(msg.species ?? []);
    }
    else if (msg.type === 'glophimon.mount') {
        enterGlophimon(msg.character, msg.starter, msg.glophimon ?? [], msg.inventory ?? { glophiballs: 0, potions: 0, daily_claim_available: false, g_coins: 1000 });
    }
    else if (msg.type === 'glophimon.menu') {
        const glophimonList = msg.glophimon ?? [];
        const inventory = msg.inventory ?? { glophiballs: 0, potions: 0, daily_claim_available: false, g_coins: 1000 };
        if (glophimonInstance && glophimonInstance.setMenuData) glophimonInstance.setMenuData(glophimonList, inventory);
    }
    else if (msg.type === 'glophimon.engageWildResult') {
        const resolve = pendingGlophimonWildRequests.get(msg.requestId);
        if (resolve) {
            pendingGlophimonWildRequests.delete(msg.requestId);
            resolve(msg.ok);
        }
    }
    else if (msg.type === 'glophimon.karirsResult') {
        const resolve = pendingKarirsRequests.get(msg.requestId);
        if (resolve) {
            pendingKarirsRequests.delete(msg.requestId);
            resolve(msg.result);
        }
    }
    else if (msg.type === 'glophimon.shopResult') {
        const resolve = pendingShopRequests.get(msg.requestId);
        if (resolve) {
            pendingShopRequests.delete(msg.requestId);
            resolve(msg.result);
        }
    }
    else if (msg.type === 'glophimon.battleResult') {
        const resolve = pendingBattleRequests.get(msg.requestId);
        if (resolve) {
            pendingBattleRequests.delete(msg.requestId);
            resolve(msg.result);
        }
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
    else if (msg.type === 'game.accessToken') {
        const resolve = pendingTokenRequests.get(msg.requestId);
        if (resolve) {
            pendingTokenRequests.delete(msg.requestId);
            resolve(msg.token);
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
    // Small, per-user, purely cosmetic preferences (e.g. a chosen board
    // theme) that should survive a webview reload but never touch any
    // backend. vscode.getState()/setState() is the mechanism a webview
    // should use for this (plain localStorage isn't reliably retained
    // across the webview being hidden/disposed, depending on
    // retainContextWhenHidden) — acquireVsCodeApi() can only be called
    // once per webview session, which already happened above, so game
    // modules reach it through this bridge instead of calling it
    // themselves. Namespaced by key so multiple games' preferences don't
    // collide in the same shared state blob.
    getPreference(key, fallback) {
        const state = vscode.getState() || {};
        return key in state ? state[key] : fallback;
    },
    setPreference(key, value) {
        const state = vscode.getState() || {};
        vscode.setState({ ...state, [key]: value });
    },
    // For a game module that connects *directly* to its own backend
    // (bypassing the send()/game.action relay entirely — see luba's
    // game.js) rather than routing every call through the extension
    // host. The host still holds the actual token; this just hands a
    // copy to the webview on request, rather than exposing it as an
    // ambient global always sitting in the page.
    getAccessToken() {
        const requestId = nextTokenRequestId++;
        return new Promise((resolve) => {
            pendingTokenRequests.set(requestId, resolve);
            vscode.postMessage({ type: 'game.getAccessToken', requestId });
        });
    },
};

function enterLubaPractice() {
    const game = window.CheddarGames && window.CheddarGames['luba'];
    if (!game || !game.mountPractice) {
        console.error('no vendored Luba practice mode — was vendor-games.sh run before packaging?');
        return;
    }
    lubaPracticeActive = true;
    lobbyViewEl.style.display = 'none';
    gameHintEl.style.display = 'none';
    gameStageEl.style.display = 'block';
    gameStageEl.dataset.mountedKey = 'luba';
    game.mountPractice(gameStageEl);
    lobbyLubaPracticeExitBtn.style.display = 'inline-block';
}

function exitLubaPractice() {
    const game = window.CheddarGames && window.CheddarGames['luba'];
    if (game) game.unmount(gameStageEl);
    gameStageEl.style.display = 'none';
    delete gameStageEl.dataset.mountedKey;
    lobbyLubaPracticeExitBtn.style.display = 'none';
    lubaPracticeActive = false;
    renderLobby(lastLobby, lastSelfId, lastTracksCompletion);
}

// GL Sims World — a single persistent shared space, not a per-lobby game
// (see games/glsimsworld/api's own plan). Reached via /glsimsworld, not
// /lobby create — mounts into gameStageEl exactly like Luba's practice
// mode above, guarded by its own glsimsWorldActive flag for the same
// reason (renderLobby()/mountGame() must not clobber it).
function renderGlSimsWorldRoster(roster) {
    glsimsWorldRosterEl.innerHTML = '';
    roster.forEach((r) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = r.taken ? `${r.name} — taken (${r.taken_by})` : r.name;
        li.appendChild(label);
        if (!r.taken) {
            const joinBtn = document.createElement('button');
            joinBtn.type = 'button';
            joinBtn.textContent = 'Join';
            joinBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'glsimsworld', action: 'join', racer: r.name });
            });
            li.appendChild(joinBtn);
        }
        glsimsWorldRosterEl.appendChild(li);
    });
    glsimsWorldHomeEl.style.display = 'block';
}

function enterGlSimsWorld(racer, displayName) {
    const game = window.CheddarGames && window.CheddarGames['glsimsworld'];
    if (!game || !game.mount) {
        console.error('no vendored GL Sims World module — was vendor-games.sh run before packaging?');
        return;
    }
    glsimsWorldActive = true;
    lobbyViewEl.style.display = 'none';
    gameHintEl.style.display = 'none';
    glsimsWorldHomeEl.style.display = 'none';
    gameStageEl.style.display = 'block';
    gameStageEl.dataset.mountedKey = 'glsimsworld';
    game.mount(gameStageEl, { racer, displayName, onRejected: exitGlSimsWorld });
    glsimsWorldLeaveBtn.style.display = 'inline-block';
}

function exitGlSimsWorld() {
    const game = window.CheddarGames && window.CheddarGames['glsimsworld'];
    if (game) game.unmount(gameStageEl);
    gameStageEl.style.display = 'none';
    delete gameStageEl.dataset.mountedKey;
    glsimsWorldLeaveBtn.style.display = 'none';
    glsimsWorldActive = false;
    renderLobby(lastLobby, lastSelfId, lastTracksCompletion);
}

glsimsWorldRefreshBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'glsimsworld', action: 'refresh' });
});
glsimsWorldLeaveBtn.addEventListener('click', exitGlSimsWorld);

// Glophimon — a single persistent shared overworld with a real per-account
// character (see games/glophimon/api's own plan). Reached via /glophimon,
// not /lobby create — same "owns gameStageEl outside the lobby, guarded by
// its own active flag" shape as GL Sims World above, plus a one-time
// creation form shown only when the account has no character yet.
// The rotate-to-inspect preview shown while the creation form is up — a
// separate lightweight mount from the real world view (see game.js's own
// mountPreview), live-recolored as the player edits their choices, since
// colors can never be changed again once the character is created.
let glophimonPreview = null;

function currentGlophimonColors() {
    return {
        head: glophimonHeadColorInput.value,
        body: glophimonBodyColorInput.value,
        arm: glophimonArmColorInput.value,
        leg: glophimonLegColorInput.value,
    };
}

function disposeGlophimonPreview() {
    if (glophimonPreview) {
        glophimonPreview.dispose();
        glophimonPreview = null;
    }
}

[glophimonHeadColorInput, glophimonBodyColorInput, glophimonArmColorInput, glophimonLegColorInput].forEach((input) => {
    input.addEventListener('input', () => {
        if (glophimonPreview) glophimonPreview.setColors(currentGlophimonColors());
    });
});

function showGlophimonCreate() {
    glophimonActive = true;
    lobbyViewEl.style.display = 'none';
    gameHintEl.style.display = 'none';
    glophimonCreateEl.style.display = 'block';
    disposeGlophimonPreview();
    const game = window.CheddarGames && window.CheddarGames['glophimon'];
    if (game && game.mountPreview) {
        glophimonPreview = game.mountPreview(glophimonPreviewEl, currentGlophimonColors());
    }
}

glophimonCreateSubmitBtn.addEventListener('click', () => {
    const displayName = glophimonNameInput.value.trim();
    if (!displayName) return;
    vscode.postMessage({
        type: 'glophimon',
        action: 'create',
        displayName,
        headColor: glophimonHeadColorInput.value,
        bodyColor: glophimonBodyColorInput.value,
        armColor: glophimonArmColorInput.value,
        legColor: glophimonLegColorInput.value,
        gender: glophimonGenderSelect.value,
    });
});

// Same rotate-to-inspect preview mechanism as character creation above,
// just its own separate instance/container (glophimon-starter-preview) —
// shown once, right after character creation, before ever entering the
// world for the first time (see doGlophimonEnter's own GET /starter
// check). Selecting a row recolors this preview to that species' colors,
// same live-update reasoning as the color pickers above.
let glophimonStarterPreview = null;
let selectedStarterKey = null;

function disposeGlophimonStarterPreview() {
    if (glophimonStarterPreview) {
        glophimonStarterPreview.dispose();
        glophimonStarterPreview = null;
    }
}

function showGlophimonStarterPicker(species) {
    glophimonActive = true;
    lobbyViewEl.style.display = 'none';
    gameHintEl.style.display = 'none';
    glophimonCreateEl.style.display = 'none';
    disposeGlophimonPreview();
    glophimonStarterEl.style.display = 'block';
    selectedStarterKey = null;
    glophimonStarterSubmitBtn.disabled = true;
    glophimonStarterListEl.innerHTML = '';

    const game = window.CheddarGames && window.CheddarGames['glophimon'];

    function selectSpecies(s) {
        selectedStarterKey = s.key;
        glophimonStarterSubmitBtn.disabled = false;
        disposeGlophimonStarterPreview();
        if (game && game.mountPreview) {
            glophimonStarterPreview = game.mountPreview(glophimonStarterPreviewEl, {
                head: s.head_color, body: s.body_color, arm: s.arm_color, leg: s.leg_color,
            });
        }
        [...glophimonStarterListEl.children].forEach((li) => {
            li.style.fontWeight = li.dataset.key === s.key ? 'bold' : 'normal';
        });
    }

    species.forEach((s, i) => {
        const li = document.createElement('li');
        li.dataset.key = s.key;
        li.style.cursor = 'pointer';
        li.style.display = 'flex';
        li.style.alignItems = 'center';
        li.style.gap = '6px';
        li.style.fontSize = '12px';
        const swatch = document.createElement('span');
        swatch.style.display = 'inline-flex';
        swatch.style.gap = '1px';
        [s.head_color, s.body_color, s.arm_color, s.leg_color].forEach((c) => {
            const dot = document.createElement('span');
            dot.style.width = '8px';
            dot.style.height = '8px';
            dot.style.background = c;
            dot.style.display = 'inline-block';
            swatch.appendChild(dot);
        });
        li.appendChild(swatch);
        li.appendChild(document.createTextNode(s.name));
        li.addEventListener('click', () => selectSpecies(s));
        glophimonStarterListEl.appendChild(li);
        if (i === 0) selectSpecies(s); // preview something immediately rather than a blank canvas
    });
}

glophimonStarterSubmitBtn.addEventListener('click', () => {
    if (!selectedStarterKey) return;
    vscode.postMessage({ type: 'glophimon', action: 'choose_starter', speciesKey: selectedStarterKey });
});

// Reference to the mounted game instance's own return value — lets the
// 'glophimon.menu' handler below push fresh data straight into the
// in-canvas menu (see game.js's own setMenuData) — the only menu now,
// there's no separate vscode-chrome panel to keep in sync any more.
let glophimonInstance = null;

function enterGlophimon(character, starter, glophimon, inventory) {
    const game = window.CheddarGames && window.CheddarGames['glophimon'];
    if (!game || !game.mount) {
        console.error('no vendored Glophimon module — was vendor-games.sh run before packaging?');
        return;
    }
    glophimonActive = true;
    lobbyViewEl.style.display = 'none';
    gameHintEl.style.display = 'none';
    disposeGlophimonPreview();
    disposeGlophimonStarterPreview();
    glophimonCreateEl.style.display = 'none';
    glophimonStarterEl.style.display = 'none';
    gameStageEl.style.display = 'block';
    gameStageEl.dataset.mountedKey = 'glophimon';
    glophimonInstance = game.mount(gameStageEl, {
        character,
        starter,
        onRejected: exitGlophimon,
        onOpenMenu: () => vscode.postMessage({ type: 'glophimon', action: 'open_menu' }),
        onActivateGlophimon: (ownedId, slot) => vscode.postMessage({ type: 'glophimon', action: 'activate_glophimon', ownedId, slot }),
        onDeactivateGlophimon: (ownedId) => vscode.postMessage({ type: 'glophimon', action: 'deactivate_glophimon', ownedId }),
        onCatchGlophimon: (catchInfo) => vscode.postMessage({ type: 'glophimon', action: 'catch_glophimon', catchInfo }),
        onReleaseGlophimon: (ownedId) => vscode.postMessage({ type: 'glophimon', action: 'release_glophimon', ownedId }),
        onUseGlophiball: () => vscode.postMessage({ type: 'glophimon', action: 'use_glophiball' }),
        onClaimDaily: () => vscode.postMessage({ type: 'glophimon', action: 'claim_daily' }),
        // "Leave Glophimon" now lives as the last row of the in-canvas menu
        // list (see game.js's own renderGlophimonMenuPanel) rather than a
        // separate vscode-chrome button — same exitGlophimon() effect either way.
        onLeaveGlophimon: exitGlophimon,
        // The Luba lobby handoff — fired once the api's own luba_start
        // handler has already configured the real match server-side (see
        // main.py) and told every member the lobby_id to connect with.
        // Nothing else in this codebase has ever called into another
        // game's mount() from inside a different game's own ctx callback
        // before this — chat.js is the only place that's allowed to own
        // gameStageEl, so the actual cross-game mount has to live here,
        // not inside game.js itself.
        onLubaMatchReady: ({ lobbyId, participants, hostId, selfId }) => {
            exitGlophimon({ skipLobbyRender: true });
            const luba = window.CheddarGames && window.CheddarGames['luba'];
            if (!luba || !luba.mount) {
                console.error('no vendored Luba module — was vendor-games.sh run before packaging?');
                return;
            }
            lubaFromGlophimon = true;
            gameStageEl.style.display = 'block';
            gameStageEl.dataset.mountedKey = 'luba';
            luba.mount(gameStageEl, {
                gameKey: 'luba',
                gameName: 'Deathmatch',
                lobbyId,
                selfId,
                leaderId: hostId,
                // {id, display_name} — matches exactly what Luba's own
                // game.js reads (ctx.participants.find(p => p.id === ...),
                // info.display_name || info.username), not a shape guessed
                // from Glophimon's own {user_id, display_name} member rows.
                participants: participants.map((m) => ({ id: m.user_id, display_name: m.display_name })),
                // Belt-and-suspenders — the button's already shown the
                // instant the match mounts (see below), so a real player
                // can leave early rather than being stuck until the timer
                // runs out; this just re-asserts it's visible once the
                // match genuinely ends too.
                onMatchOver: () => {
                    lubaReturnToGlophimonBtn.style.display = 'inline-block';
                },
            });
            // Shown for the whole match, not just once it's over — leaving
            // early and going back to Glophimon has to be possible at any
            // point, not only after the timer runs out.
            lubaReturnToGlophimonBtn.style.display = 'inline-block';
        },
        // Fire-and-forget, same trust level as everything else here — the
        // client already computed the real resulting HP (damage taken,
        // Rodz's heal, or blacking out), this just persists it.
        onSetPlayerHp: (currentHp) => vscode.postMessage({ type: 'glophimon', action: 'set_hp', currentHp }),
        // Same fire-and-forget idea, for each owned Glophimon's own HP (see
        // game.js's own syncOwnedGlophimonHp) — battle damage no longer
        // resets between fights, so it has to actually persist.
        onSetGlophimonHp: (updates) => vscode.postMessage({ type: 'glophimon', action: 'set_glophimon_hp', updates }),
        // Awaited (unlike the fire-and-forget calls above) — the battle
        // only actually starts once this resolves true, so a race with
        // another player touching the same wild resolves cleanly instead
        // of both of them ending up mid-fight with it. See game.js's own
        // checkWildContact and the 'glophimon.engageWildResult' handler.
        onEngageWild: (wildId) => {
            const requestId = nextGlophimonWildRequestId++;
            return new Promise((resolve) => {
                pendingGlophimonWildRequests.set(requestId, resolve);
                vscode.postMessage({ type: 'glophimon', action: 'engage_wild', requestId, wildId });
            });
        },
        onReleaseWild: (wildId) => vscode.postMessage({ type: 'glophimon', action: 'release_wild', wildId }),
        onWildCaught: (wildId) => vscode.postMessage({ type: 'glophimon', action: 'wild_caught', wildId }),
        // The Karirs field — all three need a real result back (see
        // 'glophimon.karirsResult' above), same awaited shape as
        // onEngageWild rather than the fire-and-forget actions further up.
        onKarirsFetchState: () => {
            const requestId = nextKarirsRequestId++;
            return new Promise((resolve) => {
                pendingKarirsRequests.set(requestId, resolve);
                vscode.postMessage({ type: 'glophimon', action: 'karirs_fetch_state', requestId });
            });
        },
        onKarirsPlaceBet: (racerName, wager) => {
            const requestId = nextKarirsRequestId++;
            return new Promise((resolve) => {
                pendingKarirsRequests.set(requestId, resolve);
                vscode.postMessage({ type: 'glophimon', action: 'karirs_place_bet', requestId, racerName, wager });
            });
        },
        onKarirsClaim: () => {
            const requestId = nextKarirsRequestId++;
            return new Promise((resolve) => {
                pendingKarirsRequests.set(requestId, resolve);
                vscode.postMessage({ type: 'glophimon', action: 'karirs_claim', requestId });
            });
        },
        // Jared's shop — awaited the same way, since the popup needs to
        // know whether the purchase actually went through.
        onShopBuy: (itemKey, quantity) => {
            const requestId = nextShopRequestId++;
            return new Promise((resolve) => {
                pendingShopRequests.set(requestId, resolve);
                vscode.postMessage({ type: 'glophimon', action: 'shop_buy', requestId, itemKey, quantity });
            });
        },
        // EXP/leveling — fired on a real wild win or catch (see game.js's
        // own awardBattleResult). Awaited: the battle log needs the real
        // per-participant EXP/level-up numbers back before it can announce
        // anything.
        onBattleResult: (payload) => {
            const requestId = nextBattleRequestId++;
            return new Promise((resolve) => {
                pendingBattleRequests.set(requestId, resolve);
                vscode.postMessage({ type: 'glophimon', action: 'battle_result', requestId, payload });
            });
        },
    });
    // Populates game.js's own menuData immediately (see its getActiveLineup)
    // rather than waiting for the player to open the Menu at least once.
    if (glophimonInstance && glophimonInstance.setMenuData) glophimonInstance.setMenuData(glophimon ?? [], inventory ?? { glophiballs: 0, potions: 0, daily_claim_available: false, g_coins: 1000 });
}

// opts.skipLobbyRender — true when the real destination right after this
// call is another mount() (see onLubaMatchReady below), not the normal
// lobby screen; without it every other caller (onRejected/onLeaveGlophimon,
// both invoked with no arguments) keeps today's exact behavior.
function exitGlophimon(opts = {}) {
    const game = window.CheddarGames && window.CheddarGames['glophimon'];
    if (game) game.unmount(gameStageEl);
    glophimonInstance = null;
    gameStageEl.style.display = 'none';
    delete gameStageEl.dataset.mountedKey;
    disposeGlophimonPreview();
    disposeGlophimonStarterPreview();
    glophimonCreateEl.style.display = 'none';
    glophimonStarterEl.style.display = 'none';
    glophimonActive = false;
    if (!opts.skipLobbyRender) renderLobby(lastLobby, lastSelfId, lastTracksCompletion);
}

function mountGame(msg) {
    if (lubaPracticeActive) return; // practice owns gameStageEl right now — see its own comment
    if (glsimsWorldActive) return; // GL Sims World owns gameStageEl right now — see its own comment
    if (glophimonActive) return; // Glophimon owns gameStageEl (or the creation form) right now — see its own comment
    if (lubaFromGlophimon) return; // a Glophimon-hosted Luba match owns gameStageEl right now — see its own comment
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

    // Practice owns gameStageEl (and the rest of this view) entirely
    // until the player explicitly exits it — a lobby-state refresh
    // arriving while practicing (someone else readying up, etc.) must not
    // re-show the normal lobby view or tear the practice session down.
    if (lubaPracticeActive) return;
    // Same reasoning — GL Sims World also owns gameStageEl outside of any
    // real lobby (see enterGlSimsWorld below).
    if (glsimsWorldActive) return;
    // Same reasoning — Glophimon also owns gameStageEl (or the creation
    // form) outside of any real lobby (see enterGlophimon below).
    if (glophimonActive) return;
    // Same reasoning — a Glophimon-hosted Luba match also owns gameStageEl,
    // and has no real lobby row for this to even look up in the first
    // place (see onLubaMatchReady below).
    if (lubaFromGlophimon) return;

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
    lobbyTitleEl.textContent = `${lobby.name} — ${lobby.status}`;

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
    lobbyChessAiConfigEl.style.display =
        isLeader && !gameLive && lobby.game_key === 'chess' && lobby.participants.length === 1 ? 'block' : 'none';
    lobbyChessColorConfigEl.style.display = isLeader && !gameLive && lobby.game_key === 'chess' ? 'block' : 'none';
    lobbyLubaConfigEl.style.display = isLeader && !gameLive && lobby.game_key === 'luba' ? 'block' : 'none';
    lobbyLubaPracticeBtn.style.display = !gameLive && lobby.game_key === 'luba' ? 'inline-block' : 'none';
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
        const isChess = lastLobby && lastLobby.game_key === 'chess';
        const isLuba = lastLobby && lastLobby.game_key === 'luba';
        vscode.postMessage({
            type: 'game',
            action: 'start',
            beatsMode: isBeats ? beatsModeSelect.value : undefined,
            beatsBpm: isBeats ? Number(beatsBpmSelect.value) : undefined,
            beatsPulseCount: isBeats ? Number(beatsPulseCountSelect.value) : undefined,
            chessColorPreference: isChess ? chessColorSelect.value : undefined,
            lubaDurationS: isLuba ? Number(lubaDurationMinutesSelect.value) * 60 : undefined,
        });
    }
    else if (e.target.id === 'chess-play-vs-ai') {
        vscode.postMessage({
            type: 'game',
            action: 'play_vs_ai',
            skillLevel: Number(chessAiSkillSelect.value),
            chessColorPreference: chessColorSelect.value,
        });
    }
    else if (e.target.id === 'lobby-luba-practice') {
        enterLubaPractice();
    }
    else if (e.target.id === 'lobby-luba-practice-exit') {
        exitLubaPractice();
    }
    else if (e.target.id === 'luba-return-to-glophimon') {
        const luba = window.CheddarGames && window.CheddarGames['luba'];
        if (luba) luba.unmount(gameStageEl);
        lubaReturnToGlophimonBtn.style.display = 'none';
        lubaFromGlophimon = false;
        gameStageEl.style.display = 'none';
        delete gameStageEl.dataset.mountedKey;
        // Same re-entry doGlophimonEnter() already does for the /glophimon
        // command and right after character/starter creation — a full
        // fresh fetch, not a special "resume" path (see extension.ts).
        vscode.postMessage({ type: 'glophimon', action: 'enter' });
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