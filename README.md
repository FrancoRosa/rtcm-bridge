# ntrip-test

Two standalone NTRIP-to-WebSocket relay servers:

- **`server.cjs`** — multi-source relay. Each configured source gets its own
  Socket.IO namespace, so different clients/rovers can pick exactly which
  base they want.
- **`server-single.cjs`** — single-source relay that additionally speaks the
  real NTRIP protocol, so a normal GNSS receiver / NTRIP client can connect
  to it directly (not just via Socket.IO).

Both keep their upstream connection(s) open continuously from the moment the
process starts, independent of whether anyone is currently watching.

## Setup

```sh
pnpm install
```

Each server reads its own config file, which is **gitignored** (it holds
caster credentials) — create it locally before running:

- `server.cjs` reads **`settings.cjs`**
- `server-single.cjs` reads **`settings-single.json`**

### `settings.cjs` (for `server.cjs`)

A plain CommonJS module, so you can comment sources out:

```js
module.exports = {
  server: {
    port: 8443,
    host: "127.0.0.1", // '0.0.0.0' to listen on all interfaces directly
    corsOrigin: "*",
    password: "1234", // dashboard login screen; change this
    tls: {
      // leave disabled if TLS is terminated by Caddy/nginx
      enabled: false,
      cert: "./certs/server.crt",
      key: "./certs/server.key",
    },
  },
  sources: [
    {
      key: "somewhere", // reachable at socket.io namespace "/minneapolis"
      host: "somewhere.com",
      port: 9000,
      mountpoint: "MOUNT",
      username: "...",
      password: "...",
      latitude: 45.06,
      longitude: -93.27,
      altitude: 0,
      interval: 5000, // how often to send GGA upstream, ms
    },
    // ...more sources
  ],
};
```

### `settings-single.json` (for `server-single.cjs`)

```json
{
  "server": {
    "port": 8443,
    "host": "0.0.0.0",
    "tls": {
      "enabled": true,
      "cert": "./certs/server.crt",
      "key": "./certs/server.key"
    },
    "ntrip": {
      "port": 2101,
      "username": "",
      "password": ""
    }
  },
  "source": {
    "id": "my-base",
    "host": "...",
    "port": 2101,
    "mountpoint": "...",
    "username": "...",
    "password": "...",
    "latitude": 0,
    "longitude": 0,
    "altitude": 0,
    "interval": 5000
  }
}
```

## `server.cjs` — multi-source relay

```sh
node server.cjs        # or: npm start
```

- Every source in `settings.cjs` connects to its upstream caster immediately
  at boot and stays connected for the life of the process, regardless of
  whether any downstream client is watching.
- Reach one source's RTCM stream by connecting Socket.IO to a namespace
  named after its `key`:

  ```js
  const socket = io("wss://your-domain/minneapolis");
  socket.on("rtcm", (data) => {
    /* raw RTCM bytes */
  });
  ```

  Connecting to a key that isn't configured is rejected outright
  (`Invalid namespace`).

- `GET /` — a live dashboard: uptime, total source/client counts, and one
  expandable panel per source (host, mountpoint, configured location, kbps,
  total bytes, health). Expanding a panel opens a live Socket.IO connection
  to that source and logs incoming RTCM chunk sizes; collapsing it
  disconnects again.
- Every RTCM message is also parsed server-side (`rtcmParser.cjs`) for
  message type 1005/1006 ("Stationary RTK Reference Station ARP"), which
  carries the *actual broadcasting* station ID and antenna position -
  independent of whatever lat/lon happens to be configured for that source.
  Once seen, a panel's "broadcast station" row shows it live; it stays
  blank ("detecting...") until the caster sends one of those message types.
- The dashboard is gated by a simple password screen (`server.password` in
  `settings.cjs`, default `1234`) - a bare, unlabeled input, terminal-style,
  centered on screen. `POST /login` with `{"password": "..."}` exchanges it
  for a session token (kept in `localStorage` so a refresh doesn't re-prompt);
  that token is required as a `Bearer` header on `/metrics`. This only gates
  the dashboard/metrics view - the RTCM Socket.IO streams themselves
  (`/minneapolis`, `/cusco`, etc.) are left open to any client, so a rover
  or app can connect directly without going through the login flow. Tokens
  are in-memory and reset on server restart; this is a lightweight
  deterrent, not hardened auth (no rate-limiting on login attempts).
- `GET /metrics` — the JSON behind that page:
  ```json
  {
    "uptimeSeconds": 123,
    "sources": [
      {
        "key": "minneapolis",
        "host": "...",
        "mountpoint": "...",
        "latitude": 45.06,
        "longitude": -93.27,
        "clients": 0,
        "ready": true,
        "error": false,
        "kbps": 4.8,
        "totalBytes": 918234,
        "lastDataAgoMs": 812,
        "station": {
          "messageType": 1006,
          "stationId": 4001,
          "latitude": 45.061498,
          "longitude": -93.275634,
          "altitude": 250.3,
          "antennaHeight": 1.5
        }
      }
    ]
  }
  ```

## `server-single.cjs` — single source, relayed two ways

```sh
node server-single.cjs   # or: npm run start:single
```

Connects to the one source in `settings-single.json` and relays it
simultaneously as:

1. **Socket.IO** (`wss`/`ws` on `server.port`) — connect and listen for
   `rtcm` events; only one stream, so no namespace/key needed.
2. **A real NTRIP caster** (raw TCP on `server.ntrip.port`, default `2101`)
   — any standard NTRIP client or GNSS receiver can connect to
   `ntrip://<host>:<port>/<mountpoint>` exactly as it would to a normal
   caster. Supports the sourcetable request (`GET /`), both the legacy
   NTRIP 1.0 (`ICY 200 OK`) and NTRIP 2.0 handshakes, and optional
   downstream Basic Auth via `server.ntrip.username`/`password`.

If `server.tls.enabled` is `true`, a missing cert/key pair is generated
(self-signed) on first boot under `certs/` and reused on every run after
that.

- `GET /status.html` — dashboard: uptime, connected client counts
  (WebSocket + NTRIP), and source health/kbps.
- `GET /metrics` — the JSON snapshot behind that page.

## Deploying behind Caddy (for real `wss://`)

Browsers (including mobile) reject self-signed certificates outright —
there is no client-side override for that. Terminate TLS with a real
certificate via Caddy instead of the built-in self-signed one:

```
your-domain.com {
    reverse_proxy 127.0.0.1:8443
}
```

Caddy auto-provisions and renews a Let's Encrypt certificate and
transparently proxies the WebSocket upgrade Socket.IO needs — no extra
config required. To use this, set `server.host` to `"127.0.0.1"` and
`server.tls.enabled` to `false` in the relevant settings file, so the Node
process only listens on loopback and Caddy is the only thing exposed
publicly on 80/443.

`server-single.cjs`'s raw NTRIP TCP port (e.g. `2101`) has no TLS support
of its own (matching how virtually all real GNSS receivers connect) — open
it directly in your firewall rather than proxying it through Caddy.

## Other files

- `geo.cjs` — WGS84 lat/lon/altitude ⇄ ECEF (`llaToEcef`/`ecefToLla`); the
  former builds the GGA sentence sent upstream, the latter turns a parsed
  RTCM antenna position back into a location.
- `rtcmParser.cjs` — decodes RTCM v3 message 1005/1006 out of an
  already-framed, CRC-validated message (as `ntrip-decoder` emits it) to
  get the broadcasting station's ID and antenna position.
- `sourceManager.cjs` — used by `server.cjs`; owns one `NtripClient` per
  source plus its Socket.IO namespace.
- `ntripCaster.cjs` — used by `server-single.cjs`; the raw-TCP NTRIP caster
  implementation (handshake, sourcetable, auth).
- `stream.cjs` — quick CLI check of one source from `settings.cjs`:
  `node stream.cjs <key>`.
