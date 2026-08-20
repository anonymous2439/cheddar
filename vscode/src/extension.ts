import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function isNewerVersion(remote: string, current: string): boolean {
    const r = remote.split('.').map(Number);
    const c = current.split('.').map(Number);
    for (let i = 0; i < Math.max(r.length, c.length); i++) {
        const rv = r[i] ?? 0;
        const cv = c[i] ?? 0;
        if (rv !== cv) return rv > cv;
    }
    return false;
}

function getMacAddress(): string | null {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name] || []) {
            if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
                return net.mac;
            }
        }
    }
    return null;
}

interface StoredSession {
    accessToken: string;
    refreshToken: string;
    username: string;
    displayName: string;
    userId: number;
}

interface ConversationSummary {
    id: number;
    label: string;
    unread: boolean;
}

interface RequestSummary {
    id: number;
    label: string;
}

interface GameCatalogEntry {
    key: string;
    name: string;
    min_players: number;
    max_players: number;
}

interface LobbyParticipant {
    user: { id: number; username: string; display_name: string };
    is_ready: boolean;
    is_leader: boolean;
}

interface LobbyState {
    id: number;
    conversation_id: number;
    game_key: string;
    game_name: string;
    status: string;
    leader_id: number | null;
    invite_code?: string | null;
    participants: LobbyParticipant[];
}

interface UpdateManifest {
    version: string;
    file: string;
    notes?: string;
}

const SESSION_SECRET_KEY = 'cheddar.session';

// Looked up by /help <command> — kept as data rather than scattered inline
// strings so the list in the bare /help summary and the detail behind each
// entry can't drift apart from the actual command set in handleCommand.
const COMMAND_HELP: Record<string, string[]> = {
    login: ['/login <username> <password> — log in to Cheddar'],
    logout: ['/logout — log out and clear the saved session'],
    whoami: ["/whoami — show who you're currently logged in as"],
    friends: ['/friends — list your friends and their online status'],
    requests: ['/requests — list incoming friend requests'],
    add: ['/add <username> — send a friend request'],
    accept: ['/accept <n> — accept a pending request from /requests, by its number'],
    decline: ['/decline <n> — decline a pending request from /requests, by its number'],
    chats: ['/chats — list your conversations'],
    open: ['/open <n> — open a conversation from /chats, by its number'],
    who: ['/who — list the members of the currently open chat'],
    leave: ['/leave — leave the currently open chat (and its lobby, if it has one)'],
    invite: ['/invite <username> — invite a friend into the currently open chat (group chats only)'],
    games: ['/games — browse the game catalog, numbered for /lobby create'],
    update: ['/update — check for, and install, a Cheddar extension update'],
    lobby: [
        "/lobby — show your current lobby's status",
        '/lobby create <n> — create a lobby for a game from /games, by its number',
        '/lobby invite <username> — invite a friend directly into your current lobby',
        '/lobby kick <username> — remove a player from your lobby (leader only)',
        '/lobby leader <username> — hand lobby leadership to another player (leader only)',
        "/lobby list — list every lobby you're currently in",
        '/lobby resume <n> — switch focus to a lobby from /lobby list, by its number',
        '/lobby code — get (or create) a shareable code for your current lobby',
        '/lobby join <code> — join a lobby using a code from /lobby code',
    ],
};

export function activate(context: vscode.ExtensionContext) {
    const provider = new MyPanelViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'cheddarPanel.view',
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
            }
        )
    );
}

export function deactivate() {}

class MyPanelViewProvider implements vscode.WebviewViewProvider {
    private webviewView?: vscode.WebviewView;

    // Cheddar chat state
    private cheddarSocket?: WebSocket;
    private accessToken?: string;
    private refreshToken?: string;
    private username?: string;
    private displayName?: string;
    private userId?: number;
    private activeConversationId?: number;
    private activeConversationTitle?: string;
    private conversationCache: ConversationSummary[] = [];
    private requestCache: RequestSummary[] = [];
    private participantNames = new Map<number, string>();

    // Game lobby state — realtime updates arrive over the same cheddarSocket
    // as chat (lobby.updated / lobby.invited / lobby.kicked / game.started).
    private gameCatalogCache: GameCatalogEntry[] = [];
    private currentLobby?: LobbyState;
    private lobbyListCache: LobbyState[] = [];

    // Karirs' per-race animation socket — separate from cheddarSocket since
    // it belongs to a different, independent API (see games/karirs/api).
    private karirsRaceSocket?: WebSocket;
    private karirsRaceSocketId?: number;

    private unread_count = 0;

    constructor(private readonly context: vscode.ExtensionContext) {}

    private get apiBaseUrl(): string {
        return vscode.workspace
            .getConfiguration('cheddar')
            .get<string>('apiBaseUrl', 'http://109.123.234.69/api/cheddar');
    }

    private get apiKey(): string {
        return vscode.workspace.getConfiguration('cheddar').get<string>('apiKey', '');
    }

    private get wsBaseUrl(): string {
        return this.apiBaseUrl.replace(/^http/, 'ws');
    }

    private get updateBaseUrl(): string {
        return vscode.workspace
            .getConfiguration('cheddar')
            .get<string>('updateBaseUrl', 'http://109.123.234.69/cheddar-builds');
    }

    private get karirsApiBaseUrl(): string {
        return vscode.workspace
            .getConfiguration('cheddar')
            .get<string>('karirsApiBaseUrl', 'http://109.123.234.69/api/karirs');
    }

    private get karirsWsBaseUrl(): string {
        return this.karirsApiBaseUrl.replace(/^http/, 'ws');
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.webviewView = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        const mac = getMacAddress();
        console.log('MAC Address:', mac);

        // Reset unread counter when tab becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.unread_count = 0;
                this.updateBadge();
            }
        });

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'input') {
                void this.handleInput(msg.text);
            }

            if (msg.type === 'game') {
                void this.handleGameAction(msg.action, msg.lobbyId, msg.username);
            }

            if (msg.type === 'game.action') {
                void this.handleGameHostAction(msg.gameKey, msg.action, msg.data);
            }
        });

        void this.restoreSession();
        void this.checkForUpdates(false);
    }

    // -----------------------------
    // 🔹 Output — every line rendered in the panel goes through here, kept
    // deliberately plain (timestamp + text) so it reads as terminal/log
    // output rather than a chat UI.
    // -----------------------------
    private log(text: string) {
        const ts = new Date().toTimeString().slice(0, 8);
        this.webviewView?.webview.postMessage({ type: 'log', text: `${ts}  ${text}` });
    }

    // -----------------------------
    // 🔹 Session persistence (SecretStorage, not globalState — these are auth tokens)
    // -----------------------------
    private async restoreSession() {
        const stored = await this.context.secrets.get(SESSION_SECRET_KEY);
        if (!stored) {
            this.log('idle — no active session. /login <username> <password>');
            return;
        }

        try {
            const session: StoredSession = JSON.parse(stored);
            this.accessToken = session.accessToken;
            this.refreshToken = session.refreshToken;
            this.username = session.username;
            this.displayName = session.displayName;
            this.userId = session.userId;

            const me = await this.authorizedFetch('/api/v1/auth/me');
            if (!me.ok) throw new Error('session invalid');

            this.log(`session restored as ${this.displayName} (@${this.username})`);
            this.connectCheddarSocket();
            void this.restoreActiveLobby();
        } catch {
            await this.clearSession();
            this.log('idle — session expired. /login <username> <password>');
        }
    }

    // Auth restores its own tokens/socket on reload, but currentLobby is
    // pure in-memory state — without this, reopening the panel after a
    // reload left no way back into a still-running game short of waiting
    // for someone else to trigger a fresh lobby.updated broadcast.
    private async restoreActiveLobby() {
        const res = await this.authorizedFetch('/api/v1/games/lobbies');
        if (!res.ok) return;

        const lobbies = (await res.json()) as LobbyState[];
        if (!lobbies.length) return;

        this.currentLobby = lobbies[0];
        this.log(`— resumed ${this.currentLobby.game_name} lobby (${this.currentLobby.status}) —`);
        this.renderLobby();
    }

    private async saveSession() {
        if (!this.accessToken || !this.refreshToken || !this.username || !this.displayName || this.userId == null) {
            return;
        }
        const session: StoredSession = {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            username: this.username,
            displayName: this.displayName,
            userId: this.userId,
        };
        await this.context.secrets.store(SESSION_SECRET_KEY, JSON.stringify(session));
    }

    private async clearSession() {
        this.accessToken = undefined;
        this.refreshToken = undefined;
        this.username = undefined;
        this.displayName = undefined;
        this.userId = undefined;
        this.setActiveConversation(undefined, undefined);
        this.conversationCache = [];
        this.requestCache = [];
        this.gameCatalogCache = [];
        this.currentLobby = undefined;
        this.renderLobby();
        await this.context.secrets.delete(SESSION_SECRET_KEY);
        this.cheddarSocket?.removeAllListeners();
        this.cheddarSocket?.close();
        this.cheddarSocket = undefined;
    }

    // -----------------------------
    // 🔹 REST helpers
    // -----------------------------
    private async rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set('X-API-Key', this.apiKey);
        if (init.body && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        return fetch(`${this.apiBaseUrl}${path}`, { ...init, headers });
    }

    private async authorizedFetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
        const headers = new Headers(init.headers);
        if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);

        const res = await this.rawFetch(path, { ...init, headers });
        if (res.status === 401 && !retried && this.refreshToken) {
            const refreshed = await this.tryRefresh();
            if (refreshed) return this.authorizedFetch(path, init, true);
        }
        return res;
    }

    private async tryRefresh(): Promise<boolean> {
        if (!this.refreshToken) return false;
        const res = await this.rawFetch('/api/v1/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refresh_token: this.refreshToken }),
        });
        if (!res.ok) return false;

        const data = (await res.json()) as { access_token: string; refresh_token: string };
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        await this.saveSession();
        return true;
    }

    // -----------------------------
    // 🔹 Input handling — every line typed into the textbox lands here.
    // A leading "/" is a command; anything else is a message to whatever
    // conversation is currently open via /open.
    // -----------------------------
    private async handleInput(raw: string) {
        const text = (raw ?? '').trim();
        if (!text) return;

        if (text.startsWith('/')) {
            await this.handleCommand(text.slice(1).trim());
            return;
        }

        if (!this.accessToken) {
            this.log('not logged in — /login <username> <password>');
            return;
        }
        if (this.activeConversationId == null) {
            this.log('no chat open — /chats then /open <n>');
            return;
        }

        this.cheddarSocket?.send(
            JSON.stringify({
                type: 'message.send',
                data: { conversation_id: this.activeConversationId, content: text },
            })
        );
    }

    private async handleCommand(cmd: string) {
        const [name, ...rest] = cmd.split(/\s+/).filter(Boolean);
        const arg = rest.join(' ');

        switch ((name || '').toLowerCase()) {
            case 'login': {
                const [user, pass] = rest;
                if (!user || !pass) {
                    this.log('usage: /login <username> <password>');
                    return;
                }
                await this.doLogin(user, pass);
                return;
            }
            case 'logout':
                await this.doLogout();
                return;
            case 'whoami':
                this.log(this.username ? `${this.displayName} (@${this.username})` : 'not logged in');
                return;
            case 'friends':
                await this.doListFriends();
                return;
            case 'requests':
                await this.doListRequests();
                return;
            case 'add':
                if (!arg) {
                    this.log('usage: /add <username>');
                    return;
                }
                await this.doAddFriend(arg);
                return;
            case 'accept':
                await this.doRespondRequest(rest[0], 'accept');
                return;
            case 'decline':
                await this.doRespondRequest(rest[0], 'decline');
                return;
            case 'chats':
                await this.doListChats();
                return;
            case 'open':
                await this.doOpenChat(rest[0]);
                return;
            case 'who':
                await this.doListMembers();
                return;
            case 'leave':
                await this.doLeaveChat();
                return;
            case 'invite':
                if (!arg) {
                    this.log('usage: /invite <username>');
                    return;
                }
                await this.doInviteToChat(arg);
                return;
            case 'games':
                await this.doListGames();
                return;
            case 'lobby':
                await this.handleLobbyCommand(rest);
                return;
            case 'update':
                await this.checkForUpdates(true);
                return;
            case 'help':
                if (arg) {
                    const lines = COMMAND_HELP[arg.toLowerCase()];
                    if (lines) {
                        lines.forEach((line) => this.log(line));
                    } else {
                        this.log(`no help for /${arg} — /help with no arguments lists every command`);
                    }
                    return;
                }
                this.log(
                    'commands: /login /logout /whoami /friends /requests /add /accept /decline /chats /open /who /leave /invite /games /lobby /update — /help <command> for details'
                );
                return;
            default:
                this.log(`unknown command: /${name}`);
        }
    }

    private async handleLobbyCommand(rest: string[]) {
        const [sub, ...subArgs] = rest;
        switch ((sub || '').toLowerCase()) {
            case undefined:
            case '':
                this.logLobbyStatus();
                return;
            case 'create':
                await this.doCreateLobby(subArgs[0]);
                return;
            case 'invite':
                if (!subArgs[0]) {
                    this.log('usage: /lobby invite <username>');
                    return;
                }
                await this.doInviteToLobby(subArgs[0]);
                return;
            case 'kick':
                if (!subArgs[0]) {
                    this.log('usage: /lobby kick <username>');
                    return;
                }
                await this.doKickFromLobby(subArgs[0]);
                return;
            case 'leader':
                if (!subArgs[0]) {
                    this.log('usage: /lobby leader <username>');
                    return;
                }
                await this.doTransferLeader(subArgs[0]);
                return;
            case 'list':
                await this.doListLobbies();
                return;
            case 'resume':
                await this.doResumeLobby(subArgs[0]);
                return;
            case 'code':
                await this.doShowInviteCode();
                return;
            case 'join':
                if (!subArgs[0]) {
                    this.log('usage: /lobby join <code>');
                    return;
                }
                await this.doJoinByCode(subArgs[0]);
                return;
            default:
                this.log(
                    'usage: /lobby [create <n>|invite <user>|kick <user>|leader <user>|list|resume <n>|code|join <code>]'
                );
        }
    }

    private async doLogin(identifier: string, password: string) {
        const res = await this.rawFetch('/api/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({ identifier, password }),
        });
        if (!res.ok) {
            this.log('login failed — check credentials');
            return;
        }

        const tokens = (await res.json()) as { access_token: string; refresh_token: string };
        this.accessToken = tokens.access_token;
        this.refreshToken = tokens.refresh_token;

        const meRes = await this.authorizedFetch('/api/v1/auth/me');
        if (!meRes.ok) {
            this.log('login succeeded but profile fetch failed — try again');
            return;
        }
        const me = (await meRes.json()) as { id: number; username: string; display_name: string };
        this.userId = me.id;
        this.username = me.username;
        this.displayName = me.display_name;

        await this.saveSession();
        this.log(`logged in as ${this.displayName} (@${this.username})`);
        this.connectCheddarSocket();
        void this.restoreActiveLobby();
    }

    private async doLogout() {
        if (this.refreshToken) {
            await this.rawFetch('/api/v1/auth/logout', {
                method: 'POST',
                body: JSON.stringify({ refresh_token: this.refreshToken }),
            }).catch(() => undefined);
        }
        await this.clearSession();
        this.log('logged out');
    }

    private async doListFriends() {
        const res = await this.authorizedFetch('/api/v1/friends');
        if (!res.ok) {
            this.log('not logged in');
            return;
        }
        const friends = (await res.json()) as Array<{ display_name: string; username: string; status: string }>;
        if (!friends.length) {
            this.log('no friends yet — /add <username>');
            return;
        }
        friends.forEach((f, i) => this.log(`${i + 1}) ${f.display_name} (@${f.username}) [${f.status}]`));
    }

    private async doListRequests() {
        const res = await this.authorizedFetch('/api/v1/friends/requests?direction=incoming');
        if (!res.ok) {
            this.log('not logged in');
            return;
        }
        const requests = (await res.json()) as Array<{
            id: number;
            user: { display_name: string; username: string };
        }>;
        this.requestCache = requests.map((r) => ({
            id: r.id,
            label: `${r.user.display_name} (@${r.user.username})`,
        }));
        if (!this.requestCache.length) {
            this.log('no pending requests');
            return;
        }
        this.requestCache.forEach((r, i) => this.log(`${i + 1}) ${r.label}`));
    }

    private async doAddFriend(username: string) {
        const searchRes = await this.authorizedFetch(`/api/v1/users/search?q=${encodeURIComponent(username)}`);
        if (!searchRes.ok) {
            this.log('not logged in');
            return;
        }
        const users = (await searchRes.json()) as Array<{ id: number; username: string }>;
        const match = users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? users[0];
        if (!match) {
            this.log(`no user found matching "${username}"`);
            return;
        }

        const res = await this.authorizedFetch('/api/v1/friends/requests', {
            method: 'POST',
            body: JSON.stringify({ user_id: match.id }),
        });
        if (res.ok) {
            this.log(`friend request sent to @${match.username}`);
        } else {
            const body = await res.json().catch(() => ({}) as { detail?: string });
            this.log(`could not send request: ${body.detail ?? res.status}`);
        }
    }

    private async doRespondRequest(indexArg: string, action: 'accept' | 'decline') {
        const idx = Number(indexArg) - 1;
        const req = this.requestCache[idx];
        if (!req) {
            this.log('run /requests first, then /accept <n>');
            return;
        }
        const res = await this.authorizedFetch(`/api/v1/friends/requests/${req.id}/${action}`, { method: 'POST' });
        this.log(res.ok ? `${action}ed request from ${req.label}` : `failed to ${action} request`);
    }

    private async doListChats() {
        const res = await this.authorizedFetch('/api/v1/conversations');
        if (!res.ok) {
            this.log('not logged in');
            return;
        }
        const conversations = (await res.json()) as Array<{
            id: number;
            name: string | null;
            participants: Array<{ id: number; display_name: string }>;
            last_message_id: number | null;
            last_read_message_id: number | null;
        }>;

        this.conversationCache = conversations.map((c) => {
            const peer = c.participants.find((p) => p.id !== this.userId);
            const label = c.name ?? peer?.display_name ?? `conversation #${c.id}`;
            const unread = c.last_message_id != null && c.last_message_id !== c.last_read_message_id;
            c.participants.forEach((p) => this.participantNames.set(p.id, p.display_name));
            return { id: c.id, label, unread };
        });

        if (!this.conversationCache.length) {
            this.log('no chats yet — message a friend from the Cheddar web app to start one');
            return;
        }
        this.conversationCache.forEach((c, i) => this.log(`${i + 1}) ${c.label}${c.unread ? '  *' : ''}`));
    }

    private async doOpenChat(indexArg: string) {
        const idx = Number(indexArg) - 1;
        const convo = this.conversationCache[idx];
        if (!convo) {
            this.log('run /chats first, then /open <n>');
            return;
        }

        this.setActiveConversation(convo.id, convo.label);
        this.log(`— opened ${convo.label} —`);

        const res = await this.authorizedFetch(`/api/v1/conversations/${convo.id}/messages`);
        if (!res.ok) return;

        const messages = (await res.json()) as Array<{
            id: number;
            sender_id: number;
            content: string | null;
            metadata: { filename: string } | null;
        }>;
        for (const m of messages.slice(-10)) {
            this.printMessage(m);
        }

        const last = messages[messages.length - 1];
        if (last) this.sendRead(convo.id, last.id);
    }

    private printMessage(m: { sender_id: number; type?: string; content: string | null; metadata: any }) {
        const who = m.sender_id === this.userId ? 'me' : (this.participantNames.get(m.sender_id) ?? `user#${m.sender_id}`);

        if (m.type === 'lobby_invite' && m.metadata?.lobby_id) {
            this.webviewView?.webview.postMessage({
                type: 'log.invite',
                text: `${who}» ${m.content ?? ''}`,
                lobbyId: m.metadata.lobby_id,
            });
            return;
        }

        const body = m.content ?? (m.metadata?.filename ? `[attachment] ${m.metadata.filename}` : '');
        this.log(`${who}» ${body}`);
    }

    private sendRead(conversationId: number, messageId: number) {
        this.cheddarSocket?.send(
            JSON.stringify({ type: 'message.read', data: { conversation_id: conversationId, message_id: messageId } })
        );
    }

    private setActiveConversation(id: number | undefined, title: string | undefined) {
        this.activeConversationId = id;
        this.activeConversationTitle = title;
        this.webviewView?.webview.postMessage({ type: 'chat.title', text: title ?? '' });
    }

    private async doListMembers() {
        if (this.activeConversationId == null) {
            this.log('no chat open — /chats then /open <n>, or /lobby create <n>');
            return;
        }
        const res = await this.authorizedFetch('/api/v1/conversations');
        if (!res.ok) {
            this.log('not logged in');
            return;
        }
        const conversations = (await res.json()) as Array<{
            id: number;
            participants: Array<{ id: number; username: string; display_name: string; status: string }>;
        }>;
        const convo = conversations.find((c) => c.id === this.activeConversationId);
        if (!convo) {
            this.log('could not find this conversation');
            return;
        }
        this.log(`— members of ${this.activeConversationTitle ?? `conversation #${convo.id}`} —`);
        convo.participants.forEach((p) => this.log(`  @${p.username} (${p.display_name}) [${p.status}]`));
    }

    private async doLeaveChat() {
        if (this.activeConversationId == null) {
            this.log('no chat open');
            return;
        }
        const conversationId = this.activeConversationId;
        const title = this.activeConversationTitle ?? `conversation #${conversationId}`;

        const res = await this.authorizedFetch(`/api/v1/conversations/${conversationId}/leave`, { method: 'POST' });
        if (!res.ok) {
            this.log('could not leave chat');
            return;
        }

        this.log(`— left ${title} —`);
        // A lobby's chat and its roster are the same membership server-side —
        // if this was the lobby's chat, the leave already took us out of the
        // lobby too, so drop the local lobby cache to match.
        if (this.currentLobby?.conversation_id === conversationId) {
            this.currentLobby = undefined;
            this.renderLobby();
        }
        this.setActiveConversation(undefined, undefined);
    }

    private async doInviteToChat(username: string) {
        if (this.activeConversationId == null) {
            this.log('no chat open — /chats then /open <n>');
            return;
        }
        const searchRes = await this.authorizedFetch(`/api/v1/users/search?q=${encodeURIComponent(username)}`);
        if (!searchRes.ok) {
            this.log('not logged in');
            return;
        }
        const users = (await searchRes.json()) as Array<{ id: number; username: string }>;
        const match = users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? users[0];
        if (!match) {
            this.log(`no user found matching "${username}"`);
            return;
        }

        const res = await this.authorizedFetch(`/api/v1/conversations/${this.activeConversationId}/invite`, {
            method: 'POST',
            body: JSON.stringify({ user_id: match.id }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}) as { detail?: string });
            this.log(`could not invite @${match.username}: ${body.detail ?? res.status}`);
            return;
        }
        this.log(`invited @${match.username} to ${this.activeConversationTitle ?? 'the chat'}`);
    }

    // -----------------------------
    // 🔹 GAME LOBBY — hidden drawer feature. Lobby mutations go over plain
    // REST; realtime fan-out (ready/kick/leader/start) arrives back over the
    // same cheddarSocket used for chat, so there's no second connection.
    // -----------------------------
    private async doListGames() {
        const res = await this.authorizedFetch('/api/v1/games/catalog');
        if (!res.ok) {
            this.log('not logged in');
            return;
        }
        this.gameCatalogCache = (await res.json()) as GameCatalogEntry[];
        if (!this.gameCatalogCache.length) {
            this.log('no games available yet');
            return;
        }
        this.gameCatalogCache.forEach((g, i) =>
            this.log(`${i + 1}) ${g.name}  (${g.min_players}-${g.max_players} players)`)
        );
        this.log('— /lobby create <n> to open a lobby —');
        this.renderCatalog();
    }

    private async doCreateLobby(indexArg: string) {
        const idx = Number(indexArg) - 1;
        const game = this.gameCatalogCache[idx];
        if (!game) {
            this.log('run /games first, then /lobby create <n>');
            return;
        }

        const res = await this.authorizedFetch('/api/v1/games/lobbies', {
            method: 'POST',
            body: JSON.stringify({ game_key: game.key }),
        });
        if (!res.ok) {
            this.log('could not create lobby');
            return;
        }
        this.currentLobby = (await res.json()) as LobbyState;
        this.setActiveConversation(this.currentLobby.conversation_id, this.lobbyChatTitle(this.currentLobby));
        this.log(`— lobby created for ${game.name} — now chatting here —`);
        this.logLobbyStatus();
        this.renderLobby();
    }

    private async doInviteToLobby(username: string) {
        if (!this.currentLobby) {
            this.log('no active lobby — /lobby create <n> first');
            return;
        }
        const searchRes = await this.authorizedFetch(`/api/v1/users/search?q=${encodeURIComponent(username)}`);
        if (!searchRes.ok) {
            this.log('not logged in');
            return;
        }
        const users = (await searchRes.json()) as Array<{ id: number; username: string }>;
        const match = users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? users[0];
        if (!match) {
            this.log(`no user found matching "${username}"`);
            return;
        }

        const res = await this.authorizedFetch(`/api/v1/games/lobbies/${this.currentLobby.id}/invite`, {
            method: 'POST',
            body: JSON.stringify({ user_id: match.id }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}) as { detail?: string });
            this.log(`could not invite @${match.username}: ${body.detail ?? res.status}`);
            return;
        }
        this.currentLobby = (await res.json()) as LobbyState;
        this.log(`invited @${match.username} to the lobby`);
        this.renderLobby();
    }

    private async doKickFromLobby(username: string) {
        if (!this.currentLobby) {
            this.log('no active lobby');
            return;
        }
        const target = this.currentLobby.participants.find(
            (p) => p.user.username.toLowerCase() === username.toLowerCase()
        );
        if (!target) {
            this.log(`"${username}" is not in this lobby`);
            return;
        }

        const res = await this.authorizedFetch(`/api/v1/games/lobbies/${this.currentLobby.id}/kick`, {
            method: 'POST',
            body: JSON.stringify({ user_id: target.user.id }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}) as { detail?: string });
            this.log(`could not kick @${username}: ${body.detail ?? res.status}`);
            return;
        }
        this.currentLobby = (await res.json()) as LobbyState;
        this.log(`kicked @${username} from the lobby`);
        this.renderLobby();
    }

    private async doTransferLeader(username: string) {
        if (!this.currentLobby) {
            this.log('no active lobby');
            return;
        }
        const target = this.currentLobby.participants.find(
            (p) => p.user.username.toLowerCase() === username.toLowerCase()
        );
        if (!target) {
            this.log(`"${username}" is not in this lobby`);
            return;
        }

        const res = await this.authorizedFetch(`/api/v1/games/lobbies/${this.currentLobby.id}/leader`, {
            method: 'POST',
            body: JSON.stringify({ user_id: target.user.id }),
        });
        if (!res.ok) {
            this.log('could not pass leadership — leader only');
            return;
        }
        this.currentLobby = (await res.json()) as LobbyState;
        this.log(`@${username} is now the lobby leader`);
        this.renderLobby();
    }

    // You can be an active participant in more than one lobby at once —
    // nothing stops that — so "the current lobby" the drawer shows is just
    // whichever one you last touched. These let you see the others and
    // switch focus back to one of them.
    private async doListLobbies() {
        const res = await this.authorizedFetch('/api/v1/games/lobbies');
        if (!res.ok) {
            this.log('not logged in');
            return;
        }
        this.lobbyListCache = (await res.json()) as LobbyState[];
        if (!this.lobbyListCache.length) {
            this.log('no active lobbies — /games then /lobby create <n>');
            return;
        }
        this.lobbyListCache.forEach((lobby, i) => {
            const mine = this.currentLobby?.id === lobby.id ? ' (current)' : '';
            this.log(`${i + 1}) ${lobby.game_name} — ${lobby.status}${mine}`);
        });
        this.log('— /lobby resume <n> to switch to one —');
    }

    private async doResumeLobby(indexArg: string) {
        const idx = Number(indexArg) - 1;
        const lobby = this.lobbyListCache[idx];
        if (!lobby) {
            this.log('run /lobby list first, then /lobby resume <n>');
            return;
        }
        this.currentLobby = lobby;
        this.log(`— resumed ${lobby.game_name} lobby (${lobby.status}) —`);
        this.renderLobby();
    }

    private async doShowInviteCode() {
        if (!this.currentLobby) {
            this.log('no active lobby');
            return;
        }
        const res = await this.authorizedFetch(`/api/v1/games/lobbies/${this.currentLobby.id}/invite-code`, {
            method: 'POST',
        });
        if (!res.ok) {
            this.log('could not get an invite code');
            return;
        }
        this.currentLobby = (await res.json()) as LobbyState;
        this.log(`— invite code: ${this.currentLobby.invite_code} — share it in any chat, anyone can /lobby join it —`);
    }

    private async doJoinByCode(code: string) {
        const res = await this.authorizedFetch('/api/v1/games/lobbies/join', {
            method: 'POST',
            body: JSON.stringify({ invite_code: code }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}) as { detail?: string });
            this.log(`could not join: ${body.detail ?? res.status}`);
            return;
        }
        this.currentLobby = (await res.json()) as LobbyState;
        this.log(`— joined ${this.currentLobby.game_name} lobby —`);
        this.renderLobby();
    }

    private async handleGameAction(action: string, lobbyIdArg?: number, username?: string) {
        if (action === 'resume_lobby' && lobbyIdArg != null) {
            const res = await this.authorizedFetch(`/api/v1/games/lobbies/${lobbyIdArg}`);
            if (res.ok) {
                this.currentLobby = (await res.json()) as LobbyState;
                this.log(`— resumed ${this.currentLobby.game_name} lobby —`);
                this.renderLobby();
            } else {
                this.log('could not open that lobby — it may have ended');
            }
            return;
        }

        if (action === 'invite') {
            if (username) await this.doInviteToLobby(username);
            return;
        }

        if (!this.currentLobby) return;
        const lobbyId = this.currentLobby.id;

        if (action === 'ready') {
            const me = this.currentLobby.participants.find((p) => p.user.id === this.userId);
            const res = await this.authorizedFetch(`/api/v1/games/lobbies/${lobbyId}/ready`, {
                method: 'POST',
                body: JSON.stringify({ is_ready: !me?.is_ready }),
            });
            if (res.ok) {
                this.currentLobby = (await res.json()) as LobbyState;
                this.renderLobby();
            }
            return;
        }

        if (action === 'start') {
            const res = await this.authorizedFetch(`/api/v1/games/lobbies/${lobbyId}/start`, { method: 'POST' });
            if (res.ok) {
                this.currentLobby = (await res.json()) as LobbyState;
                this.renderLobby();
            } else {
                const body = await res.json().catch(() => ({}) as { detail?: string });
                this.log(`could not start: ${body.detail ?? res.status}`);
            }
            return;
        }

        if (action === 'leave') {
            const res = await this.authorizedFetch(`/api/v1/games/lobbies/${lobbyId}/leave`, { method: 'POST' });
            if (res.ok) {
                this.log('— left the lobby —');
                if (this.activeConversationId === this.currentLobby.conversation_id) {
                    this.setActiveConversation(undefined, undefined);
                }
                this.currentLobby = undefined;
                this.renderLobby();
            }
            return;
        }

        if (action === 'restart') {
            const res = await this.authorizedFetch(`/api/v1/games/lobbies/${lobbyId}/restart`, { method: 'POST' });
            if (res.ok) {
                this.currentLobby = (await res.json()) as LobbyState;
                this.renderLobby();
            } else {
                const body = await res.json().catch(() => ({}) as { detail?: string });
                this.log(`could not restart: ${body.detail ?? res.status}`);
            }
            return;
        }
    }

    private lobbyChatTitle(lobby: LobbyState): string {
        return `${lobby.game_name} lobby`;
    }

    private logLobbyStatus() {
        const lobby = this.currentLobby;
        if (!lobby) {
            this.log('no active lobby — /games then /lobby create <n>');
            return;
        }
        this.log(`— ${lobby.game_name} lobby (${lobby.status}) —`);
        lobby.participants.forEach((p) => {
            const tags = [p.is_leader ? 'leader' : null, p.is_ready ? 'ready' : 'not ready']
                .filter(Boolean)
                .join(', ');
            this.log(`  @${p.user.username} — ${tags}`);
        });
    }

    private applyLobbyUpdate(lobby: LobbyState) {
        const wasMine = this.currentLobby?.id === lobby.id;
        const amStillIn = lobby.participants.some((p) => p.user.id === this.userId);
        if (wasMine || amStillIn) {
            if (!amStillIn && this.activeConversationId === lobby.conversation_id) {
                this.setActiveConversation(undefined, undefined);
            }
            this.currentLobby = amStillIn ? lobby : undefined;
            this.renderLobby();
        }
    }

    private renderCatalog() {
        this.webviewView?.webview.postMessage({ type: 'catalog.render', data: this.gameCatalogCache });
    }

    private renderLobby() {
        if (!this.currentLobby) this.closeKarirsRaceSocket();
        this.webviewView?.webview.postMessage({
            type: 'lobby.render',
            data: this.currentLobby ?? null,
            selfId: this.userId,
        });
    }

    // Hands a vendored game module (media/games/<key>/game.js, registered on
    // window.CheddarGames) everything it needs to render without it ever
    // touching the Cheddar API itself.
    private mountGame(gameKey: string, gameName: string) {
        if (!this.currentLobby) return;
        this.webviewView?.webview.postMessage({
            type: 'game.mount',
            gameKey,
            gameName,
            lobbyId: this.currentLobby.id,
            selfId: this.userId,
            leaderId: this.currentLobby.leader_id,
            participants: this.currentLobby.participants.map((p) => p.user),
        });
    }

    private async sendGameEvent(gameKey: string, event: string, data: unknown) {
        this.webviewView?.webview.postMessage({ type: 'game.event', gameKey, event, data });
    }

    // A mounted module only ever reaches its own game's API through this —
    // it holds no token and makes no network calls of its own. Right now
    // 'karirs' is the only game with a backend; a future game with its own
    // API would get its own branch here rather than a shared one, since each
    // game's action set and base URL are its own concern.
    private async handleGameHostAction(gameKey: string, action: string, data: any) {
        if (gameKey === 'karirs') {
            await this.handleKarirsAction(action, data);
        }
    }

    private async karirsFetch(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
        if (init.body && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        return fetch(`${this.karirsApiBaseUrl}${path}`, { ...init, headers });
    }

    private async handleKarirsAction(action: string, data: any) {
        try {
            switch (action) {
                case 'sync_race': {
                    // POST already does exactly the right thing on its own:
                    // reuse the lobby's still-active (betting_open/racing)
                    // race if there is one, otherwise deal a fresh one — it
                    // excludes resolved races from the "reuse" check. A
                    // GET-the-latest-race-first approach used to sit in front
                    // of this, but that endpoint returns the latest race
                    // regardless of status, so once a lobby's first race ever
                    // resolved it would keep being "found" forever and this
                    // fallback-to-POST path would never run again — every
                    // later game session just showed the old, finished race.
                    const res = await this.karirsFetch('/races', {
                        method: 'POST',
                        body: JSON.stringify({ lobby_id: data.lobbyId }),
                    });
                    if (!res.ok) throw new Error(`race sync failed (${res.status})`);
                    const race = await res.json();
                    this.ensureKarirsRaceSocket(race.id);
                    await this.sendGameEvent('karirs', 'race', race);
                    return;
                }
                case 'wallet': {
                    const res = await this.karirsFetch('/wallet');
                    if (!res.ok) throw new Error(`wallet fetch failed (${res.status})`);
                    await this.sendGameEvent('karirs', 'wallet', await res.json());
                    return;
                }
                case 'pool': {
                    const res = await this.karirsFetch(`/races/${data.raceId}/pool`);
                    if (!res.ok) throw new Error(`pool fetch failed (${res.status})`);
                    await this.sendGameEvent('karirs', 'pool', await res.json());
                    return;
                }
                case 'my_bet': {
                    const res = await this.karirsFetch(`/races/${data.raceId}/bets`);
                    if (!res.ok) throw new Error(`bet fetch failed (${res.status})`);
                    await this.sendGameEvent('karirs', 'my_bet', await res.json());
                    return;
                }
                case 'place_bet': {
                    const res = await this.karirsFetch(`/races/${data.raceId}/bets`, {
                        method: 'POST',
                        body: JSON.stringify({ racer_name: data.racerName, wager: data.wager }),
                    });
                    if (!res.ok) {
                        const body = await res.json().catch(() => ({}) as { detail?: string });
                        throw new Error(body.detail ?? `bet failed (${res.status})`);
                    }
                    await this.sendGameEvent('karirs', 'bet_placed', await res.json());
                    return;
                }
                default:
                    throw new Error(`unknown karirs action: ${action}`);
            }
        } catch (err) {
            await this.sendGameEvent('karirs', 'error', { message: (err as Error).message });
        }
    }

    // Live per-step race animation rides its own socket to Karirs' own API —
    // separate from cheddarSocket, which only knows about chat/lobby events.
    // Connecting is harmless before betting even closes: the server sends
    // nothing until the race actually starts running.
    private ensureKarirsRaceSocket(raceId: number) {
        if (this.karirsRaceSocketId === raceId && this.karirsRaceSocket) return;

        this.closeKarirsRaceSocket();
        this.karirsRaceSocketId = raceId;

        const url = `${this.karirsWsBaseUrl}/races/${raceId}/ws?token=${encodeURIComponent(this.accessToken ?? '')}`;
        const socket = new WebSocket(url);
        this.karirsRaceSocket = socket;

        socket.on('error', () => {
            // Quiet on purpose, matching cheddarSocket's own error handling.
        });

        socket.on('message', (data) => {
            let event: { type: string; [key: string]: any };
            try {
                event = JSON.parse(data.toString());
            } catch {
                return;
            }

            if (event.type === 'step') {
                void this.sendGameEvent('karirs', 'race_step', event);
            } else if (event.type === 'resolved') {
                // Deliberately no per-user bets here — see the API's own
                // comment on this broadcast; race+standings+pool only.
                void this.sendGameEvent('karirs', 'race_finished', {
                    race: event.race,
                    standings: event.standings,
                    pool: event.pool,
                });
                this.closeKarirsRaceSocket();
            }
        });
    }

    private closeKarirsRaceSocket() {
        this.karirsRaceSocket?.removeAllListeners();
        this.karirsRaceSocket?.close();
        this.karirsRaceSocket = undefined;
        this.karirsRaceSocketId = undefined;
    }

    // -----------------------------
    // 🔹 CHEDDAR CHAT SOCKET
    // -----------------------------
    private connectCheddarSocket() {
        if (!this.accessToken) return;

        this.cheddarSocket?.removeAllListeners();
        this.cheddarSocket?.close();

        const url = `${this.wsBaseUrl}/api/v1/ws?token=${encodeURIComponent(this.accessToken)}&api_key=${encodeURIComponent(this.apiKey)}`;
        this.cheddarSocket = new WebSocket(url);

        this.cheddarSocket.on('error', () => {
            // Kept quiet deliberately — a visible error line for every dropped
            // connection would look out of place among plain log output.
        });

        this.cheddarSocket.on('message', (data) => {
            let event: { type: string; data: any };
            try {
                event = JSON.parse(data.toString());
            } catch {
                return;
            }

            if (event.type === 'message.new') {
                const m = event.data;
                if (m.conversation_id === this.activeConversationId) {
                    this.printMessage(m);
                    if (m.sender_id !== this.userId) this.sendRead(m.conversation_id, m.id);
                    if (this.webviewView?.visible) {
                        this.unread_count = 0;
                    } else if (m.sender_id !== this.userId) {
                        this.unread_count++;
                    }
                } else if (m.sender_id !== this.userId) {
                    this.unread_count++;
                    this.log('— new message, /chats to see —');
                }
                this.updateBadge();
            } else if (event.type === 'error') {
                this.log(`error: ${event.data?.message}`);
            } else if (event.type === 'lobby.updated') {
                this.applyLobbyUpdate(event.data as LobbyState);
            } else if (event.type === 'lobby.invited') {
                const lobby = event.data as LobbyState;
                this.currentLobby = lobby;
                this.setActiveConversation(lobby.conversation_id, this.lobbyChatTitle(lobby));
                this.log(`— invited to ${lobby.game_name} lobby by a friend — now chatting here —`);
                this.logLobbyStatus();
                this.renderLobby();
            } else if (event.type === 'lobby.kicked') {
                const lobby = this.currentLobby;
                if (lobby && lobby.id === event.data?.lobby_id) {
                    this.log('— you were removed from the lobby —');
                    if (this.activeConversationId === lobby.conversation_id) {
                        this.setActiveConversation(undefined, undefined);
                    }
                    this.currentLobby = undefined;
                    this.renderLobby();
                }
            } else if (event.type === 'game.started') {
                const lobby = this.currentLobby;
                if (lobby && lobby.id === event.data?.lobby_id) {
                    // start_lobby only broadcasts game.started/message.new, not
                    // lobby.updated — reflect the status change locally so a
                    // non-leader's Ready/Start buttons hide correctly too.
                    this.currentLobby = { ...lobby, status: 'in_progress' };
                    this.log(`— ${event.data.game_name} has started! —`);
                    this.renderLobby();
                    this.mountGame(event.data.game_key, event.data.game_name);
                }
            } else if (event.type === 'conversation.invited') {
                const name = event.data?.name ?? `conversation #${event.data?.id}`;
                this.log(`— added to a group chat: ${name} — /chats to see it —`);
            }
        });
    }

    // -----------------------------
    // 🔹 SELF-UPDATE — this is a private/sideloaded extension so it can't rely
    // on the Marketplace's update mechanism. `interactive: false` (checked
    // once when the panel first launches) only notifies; it never installs
    // anything on its own. `interactive: true` (the /update command) is the
    // only path that actually downloads and installs a new version.
    // -----------------------------
    private async checkForUpdates(interactive: boolean) {
        const currentVersion = this.context.extension.packageJSON.version as string;

        let manifest: UpdateManifest;
        try {
            const res = await fetch(`${this.updateBaseUrl}/latest.json`);
            if (!res.ok) throw new Error(`status ${res.status}`);
            manifest = (await res.json()) as UpdateManifest;
        } catch (err) {
            if (interactive) this.log(`update check failed: ${(err as Error).message}`);
            return;
        }

        if (!isNewerVersion(manifest.version, currentVersion)) {
            if (interactive) this.log(`up to date (v${currentVersion})`);
            return;
        }

        if (!interactive) {
            this.log(`— update available: v${currentVersion} → v${manifest.version} — /update to install —`);
            void vscode.window.showInformationMessage(
                `Cheddar v${manifest.version} is available (current: v${currentVersion}). Run /update in the Cheddar panel to install it.`
            );
            return;
        }

        await this.installUpdate(manifest);
    }

    private async installUpdate(manifest: UpdateManifest) {
        this.log(`downloading v${manifest.version}...`);
        try {
            const res = await fetch(`${this.updateBaseUrl}/${manifest.file}`);
            if (!res.ok) throw new Error(`download failed: status ${res.status}`);

            const buffer = Buffer.from(await res.arrayBuffer());
            const tmpPath = path.join(os.tmpdir(), manifest.file);
            fs.writeFileSync(tmpPath, buffer);

            await vscode.commands.executeCommand(
                'workbench.extensions.installExtension',
                vscode.Uri.file(tmpPath)
            );

            this.log(`installed v${manifest.version} — reload the window to finish`);
            const choice = await vscode.window.showInformationMessage(
                `Cheddar v${manifest.version} installed. Reload window to finish updating?`,
                'Reload now'
            );
            if (choice === 'Reload now') {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } catch (err) {
            this.log(`update failed: ${(err as Error).message}`);
        }
    }

    private updateBadge() {
        if (!this.webviewView) return;

        this.webviewView.badge = {
            value: this.unread_count,
            tooltip: `${this.unread_count} unread messages`,
        };
    }

    // Vendored game modules (media/games/<key>/game.js) are dropped in by
    // vendor-games.sh from each game's own independent build — this just
    // discovers whatever landed there and gives each one a <script> tag so
    // it can register itself on window.CheddarGames before chat.js needs it.
    private getGameScriptTags(): string {
        const gamesDir = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'games');
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(gamesDir.fsPath, { withFileTypes: true });
        } catch {
            return '';
        }

        return entries
            .filter((e) => e.isDirectory())
            .map((e) => vscode.Uri.joinPath(gamesDir, e.name, 'game.js'))
            .filter((uri) => fs.existsSync(uri.fsPath))
            .map((uri) => `<script src="${this.webviewView!.webview.asWebviewUri(uri).toString()}"></script>`)
            .join('\n    ');
    }

    private getHtml(): string {
        const html_path = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.html');
        const css_path = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css');
        const js_path = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js');

        const html = fs.readFileSync(html_path.fsPath, 'utf8');

        const cssUri = this.webviewView!.webview.asWebviewUri(css_path);
        const scriptUri = this.webviewView!.webview.asWebviewUri(js_path);

        return html
            .replace('{{styleUri}}', cssUri.toString())
            .replace('{{gameScripts}}', this.getGameScriptTags())
            .replace('{{scriptUri}}', scriptUri.toString());
    }
}
