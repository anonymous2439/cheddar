# Cheddar (mobile)

React Native / Expo port of [`../web`](../web) — same chat backend (`../api`), same features: auth,
friends, real-time messaging over WebSocket, image/file attachments, emoji shortcuts.

## Structure

Mirrors the web app's architecture:

- `src/api/` — axios client + endpoints (identical shape to web, storage swapped to `AsyncStorage`)
- `src/context/` — `AuthContext`, `WebSocketContext`, `ChatDataContext` (shares chat state across screens)
- `src/hooks/useChatData.ts` — ported unchanged, UI-agnostic
- `src/screens/` — `Login`, `Register`, `Home` (conversations/friends tabs), `ChatDetail`
- `src/components/` — `ConversationList`, `FriendsPanel`, `EmojiPicker`

## Setup

```
npm install
```

Copy `.env.example` to `.env.local` and fill in your API key (same key the `web` app uses):

```
EXPO_PUBLIC_API_BASE_URL=http://109.123.234.69/api/cheddar
EXPO_PUBLIC_API_KEY=...
```

`../api` (FastAPI, port 8008) only binds to `127.0.0.1` on the server — it's not reachable directly.
It's exposed publicly through the nginx reverse proxy already configured at `/etc/nginx/sites-available/default`
(`location /api/cheddar/ { proxy_pass http://127.0.0.1:8008/; ... }`), the same path the `web` app's
production build (`VITE_API_BASE_URL=/api/cheddar`) already relies on. So `EXPO_PUBLIC_API_BASE_URL`
should point at that public host + `/api/cheddar`, not at `localhost`/`10.0.2.2`/a LAN IP — those only
work when the API server and the phone are the same machine or on the same local network, which isn't
the case here since the API runs on a remote box.

Android blocks plain `http://` traffic by default (API 28+). Expo Go allows it for convenience, but a
standalone/EAS build needs it explicitly enabled — already configured via the `expo-build-properties`
plugin (`usesCleartextTraffic: true`) in `app.json`. If the API ever moves behind HTTPS, that plugin
config can be removed.

## Running

No local Android SDK/Java is required for development — Expo Go handles that.

```
npx expo start
```

Scan the QR code with the **Expo Go** app on an Android phone, or press `a` to launch an Android
emulator if you have one configured locally.

## Building an installable APK

Since there's no local Android SDK in this environment, builds go through [EAS Build](https://docs.expo.dev/build/introduction/)
(Expo's cloud build service) instead of a local Gradle build. `eas.json` is already configured with
three profiles, all producing an `.apk` (rather than the Play-Store-only `.aab`) for direct install:

- `development` — includes the dev client, for iterating without Expo Go
- `preview` — a release-mode build for testing, reads env vars from your local `.env.local`
- `production` — release-mode, auto-incrementing version code, with the API URL/key baked in via
  `eas.json`'s `env` block (so it doesn't depend on your local `.env.local` being present)

This requires a free Expo account, and each build runs on Expo's servers (uses your account's build
minutes/quota — free tier includes a limited number per month):

```
npx eas login          # one-time, opens a browser to authenticate
npx eas build --platform android --profile production
```

The command prints a build log URL and, once it finishes (a few minutes), a link to download the
signed `.apk` directly — no Play Store submission needed to install it on a device (enable "install
from unknown sources" on the phone, or use `npx eas build:run` to install it via USB automatically).

The very first build on a fresh Expo project will also prompt to generate/store an Android signing
keystore — let EAS manage it unless you already have one you need to reuse.
