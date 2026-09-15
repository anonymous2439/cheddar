// Direct WebSocket connection to GL Sims World's own backend — bypassing
// the extension's send()/game.action relay entirely, same architecture
// decision and same reasoning as Luba's net/lubaSocket.js: continuous
// position broadcasts plus live chat is exactly the "many messages a
// second, not occasional" case that relay was never built for.
// window.CheddarHost still brokers the one sensitive value this needs
// (the access token, via getAccessToken()) and
// window.CheddarGlSimsWorldWsBaseUrl is baked into the page by
// extension.ts from the user's own vscode settings.
export const NETWORK_TICK_MS = 100; // casual walking, not combat — far less frequent than Luba's own tick

export function connectWorldSocket(racer, displayName, onMessage) {
  let ws = null;
  let closed = false;

  async function connect() {
    const wsBase = window.CheddarGlSimsWorldWsBaseUrl;
    if (!wsBase) {
      onMessage({ type: "_error", message: "GL Sims World backend URL not configured" });
      return;
    }
    const token = await window.CheddarHost.getAccessToken();
    if (closed) return; // unmounted while awaiting the token
    const url =
      `${wsBase}/ws?racer=${encodeURIComponent(racer)}` +
      `&display_name=${encodeURIComponent(displayName)}` +
      `&token=${encodeURIComponent(token || "")}`;
    ws = new WebSocket(url);
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage(msg);
    });
    ws.addEventListener("close", (event) => {
      if (closed) return;
      // A rejection (taken/already_in_world/unknown_racer/unauthorized) is
      // delivered as a real 'rejected' message *before* this fires (see
      // main.py's _reject — closing before accept() surfaces to the
      // browser as a bare handshake failure with no code/reason at all,
      // confirmed directly against this exact backend), so this handler
      // only needs to cover an unexpected drop after a successful join.
      onMessage({ type: "_disconnected", code: event.code });
    });
    ws.addEventListener("error", () => {
      // Quiet on purpose, matching cheddarSocket's own error handling —
      // the close event above (or an explicit 'rejected' message) is what
      // actually drives UI state.
    });
  }
  connect();

  return {
    sendPosition(x, z, facing) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "position", x, z, facing }));
      }
    },
    sendChat(text) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chat", text }));
      }
    },
    dispose() {
      closed = true;
      ws?.close();
    },
  };
}
