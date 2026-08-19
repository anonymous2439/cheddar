import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as os from 'os';

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

const SESSION_SECRET_KEY = 'cheddar.session';

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
    private conversationCache: ConversationSummary[] = [];
    private requestCache: RequestSummary[] = [];
    private participantNames = new Map<number, string>();

    // Game socket — separate feature, untouched by the Cheddar integration.
    private gameSocket?: WebSocket;
    private default_game_ws_url = 'ws://109.123.234.69/karirs/';

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

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.webviewView = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        this.connectGameSocket(this.default_game_ws_url);

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

            if (msg.type === 'karirs') {
                this.gameSocket?.send(JSON.stringify(msg.data));
            }
        });

        void this.restoreSession();
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
        } catch {
            await this.clearSession();
            this.log('idle — session expired. /login <username> <password>');
        }
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
        this.activeConversationId = undefined;
        this.conversationCache = [];
        this.requestCache = [];
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
            case 'help':
                this.log('commands: /login /logout /whoami /friends /requests /add /accept /decline /chats /open');
                return;
            default:
                this.log(`unknown command: /${name}`);
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

        this.activeConversationId = convo.id;
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

    private printMessage(m: { sender_id: number; content: string | null; metadata: { filename: string } | null }) {
        const who = m.sender_id === this.userId ? 'me' : (this.participantNames.get(m.sender_id) ?? `user#${m.sender_id}`);
        const body = m.content ?? (m.metadata ? `[attachment] ${m.metadata.filename}` : '');
        this.log(`${who}» ${body}`);
    }

    private sendRead(conversationId: number, messageId: number) {
        this.cheddarSocket?.send(
            JSON.stringify({ type: 'message.read', data: { conversation_id: conversationId, message_id: messageId } })
        );
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
            }
        });
    }

    // -----------------------------
    // 🔹 GAME SOCKET (fixed, unrelated to Cheddar chat — untouched)
    // -----------------------------
    private connectGameSocket(url: string) {
        if (this.gameSocket) {
            this.gameSocket.removeAllListeners();
            this.gameSocket.close();
        }

        this.gameSocket = new WebSocket(url);

        this.gameSocket.on('open', () => {
            console.log('Game WebSocket connected:', url);
        });

        this.gameSocket.on('close', () => console.log('Game WebSocket closed:', url));
        this.gameSocket.on('error', (err) => console.error('Game WebSocket error:', err));

        this.gameSocket.on('message', (data) => {
            if (this.webviewView) {
                this.webviewView.webview.postMessage({
                    type: 'karirs',
                    data: data.toString(),
                });
            }
        });
    }

    private updateBadge() {
        if (!this.webviewView) return;

        this.webviewView.badge = {
            value: this.unread_count,
            tooltip: `${this.unread_count} unread messages`,
        };
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
            .replace('{{scriptUri}}', scriptUri.toString());
    }
}
