# CortenDesk Share: a standalone sharing gateway next to CortenDesk

## Intent

Frank shows his own screen to colleagues who sit behind bad firewalls, or
where Teams screen sharing works poorly. RustDesk through a browser over HTTPS
is much faster for them. He makes a link on the spot, picks what the guests may
do and which screen they see, and pastes the link in a chat.

CortenDesk (marcpope/cortendesk) now has light share links. They open the web
client with no password, the device shows RustDesk's accept window, and the
person at the device clicks Accept. Marc declined a gateway in core. This
project adds what the light links can't do, without changing CortenDesk:

- **Enforced rights.** Rights are fixed in the link and enforced on the server.
  A guest with devtools can't do more than the link allows.
- **One screen only.** The guest sees only the screen that was chosen and
  can't switch to another.
- **Screen preview.** When making a link, Frank sees a thumbnail of each
  screen of the device.
- **No Accept click.** The gateway logs in with the device password, which
  never reaches the guest.
- **Clear naming in RustDesk.** The connection shows as
  `RustdeskShare · <link label> · <guest name> · <guest IP>`.

## Goals

- A separate container, `cortendesk-share`, in its own public repository
  `frankhommers/cortendesk-share`. AGPL-3.0, because it reuses CortenDesk's
  AGPL web client code and serves guests over the network.
- The image is published to `ghcr.io/frankhommers/cortendesk-share` by GitHub
  Actions.
- It works with an unmodified CortenDesk: the console and CortenDesk Server
  (hbbs/hbbr), in both access modes ("open" and "approved only").

## Non-goals

- Changes to CortenDesk or its PRs. Frank wants upstream left alone.
- Reading or writing CortenDesk's database. Only its HTTP APIs and the
  RustDesk WebSocket endpoints are used, because Marc changes the schema
  freely.
- Multiple owners. Frank is the only user today. Several emails are allowed,
  but there is no per-user device ownership.
- Terminal and camera connections. Screen, control, clipboard, files, audio
  and chat only.
- Recording, or anything not listed under "Rights".

## Anti-goals (a failure even if it works)

- The device password, or its RustDesk login hash, reaches a guest's browser.
- A guest gets more than the link allows, including by talking to the gateway
  directly.
- A link to one device gives any access to another device.
- An ended or expired link keeps a guest connected for more than a few
  seconds.
- Anyone not on the allowlist reaches the admin pages.

## Constraints

- Never build on the NAS (IRONJAW). Images come from GitHub Actions only.
- No deploys to IRONJAW unless Frank asks. The work ends at "image on ghcr"
  plus a compose example.
- The repo is public, so it contains no secrets, hostnames or keys of Frank's
  setup. Everything comes from environment variables.

## Architecture

```
guest browser ──https/wss──► cortendesk-share ──wss /ws/id, /ws/relay──► CortenDesk Server ──► device
admin browser ──https/wss──►   (Node)          ──https /api/*─────────► CortenDesk console
                                 │
                                 └── /data/share.sqlite (links, sessions, device passwords, own identity)
```

### Reuse

The gateway logic already exists, written and tested earlier in Frank's fork
(`frankhommers/cortendesk`, branch `feature/share-links-gateway`). The builder
copies it as the starting point:

- `webclient/src/gateway/server.ts` and `policy.ts` (allowlist both ways,
  `DisplayGate`, login building), and `policy.test.ts`.
- The protocol core of the web client (`webclient/src/core`, `transport`,
  `worker`, protos) and its UI (`webclient/src/ui`) for the guest viewer, in
  "share mode". The gateway-mode changes in `session.ts` and the worker from
  that branch are included.
- The old spec, `docs/superpowers/specs/2026-11-04-share-links-design.md` in
  that branch, describes the allowlist and display rules. They still apply
  unless this document says otherwise.

What changes is where the gateway gets its data. The old gateway asked the
console over loopback endpoints that only existed in the fork. Now it keeps
its own data and talks to the console's public APIs.

### How the gateway talks to CortenDesk

All verified against CortenDesk main and cortendesk-server main on 2026-11-06.

1. **Its own RustDesk identity.** On first boot the gateway creates a
   RustDesk ID (9 digits) and a uuid, and stores them in `/data`.
2. **Service account login.** `POST /api/login` with a dedicated console user
   (`CD_USERNAME` / `CD_PASSWORD`), sending its own `id` and `uuid` like a
   RustDesk client. The answer is a client access token. The account must
   not use 2FA or emailed sign-in codes, because the gateway can't answer
   them. Startup checks this and shows a clear error in the admin page. When
   the token expires or is rejected, the gateway logs in again.
3. **Appearing as a device.** It sends `/api/sysinfo` once and
   `/api/heartbeat` periodically, so it shows up in the console as a device
   called "RustdeskShare". In "approved only" mode hbbs only admits
   initiators whose token maps to an approved device that may initiate
   (`check_initiator` in `cortendesk-server/src/policy.rs`). The admin approves
   this device once. The admin page shows when connections are refused for
   this reason.
4. **Devices.** `GET /api/peers` with the token lists the devices the service
   account can see, with online status, hostname and alias.
5. **Server key.** `POST /api/server-config` with the token returns the
   server's public key. That is the key used for the signed key exchange.
6. **Connecting.** Through `/ws/id` and `/ws/relay` on the console's public
   URL (`CD_URL`), the same endpoints CortenDesk's own web client uses. The
   access token goes in the punch hole `token` field. Signed `cdw` tickets are
   not used.

### Data (SQLite in `/data`)

- **identity:** RustDesk ID, uuid, the current access token.
- **device_passwords:** per RustDesk device ID, the device's permanent
  password, encrypted with `SHARE_SECRET_KEY` (a key from the environment,
  not stored in `/data`). It is entered once per device in the admin page and
  can be replaced or removed. *Builder's call: per device, not per link, so a
  new link doesn't ask again.*
- **links:** id, token hash (SHA-256, the token itself is shown once), label,
  device ID, display (index or null for all), rights, max viewers, expires
  at, revoked at, created at, last used at.
- **sessions:** link, guest name, guest IP, user agent, start, last seen,
  end, end reason, dropped message count.

### Admin pages (OIDC)

- **Login** through OIDC (`OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`), ideally the same provider CortenDesk uses, so it's
  the same account. Only emails in `SHARE_ALLOWED_EMAILS` (comma-separated)
  get in. Everyone else sees "no access" after login. There is no local
  password login.
- **Device list:** the devices from `/api/peers`, with online state and
  whether a password is stored.
- **New link**, the main screen:
  1. Pick a device. If it has no stored password, ask for it (optional).
  2. **Preview.** The gateway opens a short view-only connection to the
     device, logs in with the stored password, reads the displays from
     PeerInfo and captures one frame of each. The admin page shows a
     thumbnail per screen with its number and resolution, decoded in the
     browser like the normal viewer. The connection closes after the
     thumbnails, at most about 10 seconds. In RustDesk it shows as
     `RustdeskShare · preview`. Without a stored password the preview
     triggers the device's accept window, and the page says so.
  3. Pick a screen by clicking its thumbnail, or "all screens".
  4. Pick rights (below), the duration (15 min, 1 h default, 8 h, 24 h,
     7 days), the max viewers (default 1) and a label.
  5. Create. The link is shown once with a copy button.
- **Active links:** label, device, screen, rights, expiry, live viewers (name
  and IP), and an "End" button. Ending a link disconnects its guests within a
  few seconds.
- **Log:** past sessions, with the fields from the sessions table.

### Rights (per link, chosen when the link is made)

| Right | Default | Effect |
|---|---|---|
| Watch | always | video and cursor |
| Mouse and keyboard | off | input passes through |
| Clipboard | off | both directions |
| Files | off | file transfer connection |
| Audio | off | sound from the device |
| Chat | on | chat messages |

Enforcement works as in the old spec: an allowlist in both directions, and
defence in depth through the login options (`disable_keyboard`,
`disable_clipboard`, `disable_audio`, `enable_file_transfer`). The rule
"never allowed through a share" from the old spec still holds, for example
restart, elevation, privacy mode, block input, switch sides and a second
login.

### Guest flow

1. The guest opens `https://<share host>/s#<token>`. The token stays in the
   fragment, so it is not in any access log.
2. The page shows the link label and the device name, and asks
   "Your name" (optional, at most 40 characters).
3. The guest clicks Connect. The page opens a WebSocket to the gateway and
   sends the token and name. The gateway checks the link (valid, not expired,
   not revoked, viewer limit), records the session, connects to the device and
   logs in.
4. The name RustDesk shows is
   `RustdeskShare · <label> · <guest name or "Guest"> · <IP>`, cut to what
   RustDesk displays.
   The guest IP comes from the TCP peer, or from `X-Forwarded-For` only when
   the peer is in `TRUSTED_PROXIES`.
5. The guest sees the viewer in share mode: only the chosen screen, and only
   the tools the rights allow.
6. If the link ends or expires, the gateway closes the session and the page
   shows "This link has ended".

Without a stored device password, the gateway logs in with an empty password
and the device shows its accept window. That is the CortenDesk light
behaviour, with the rights still enforced.

### Display limit

As in the old spec (`DisplayGate`): the guest's PeerInfo lists only the shared
display, video for other displays is dropped, and mouse positions are clamped
to it. The index follows the device's own order. Because the link is made
right after the preview, that order matches what Frank saw. If the display
disappears, the session ends with a clear message.

### Configuration (environment)

`CD_URL` (console base URL), `CD_USERNAME`, `CD_PASSWORD`, `SHARE_PUBLIC_URL`
(base URL of the share host, used in links), `SHARE_SECRET_KEY`,
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SHARE_ALLOWED_EMAILS`,
`TRUSTED_PROXIES`, `PORT`. The README holds a compose example and explains
the one-time steps: create the service account, approve the
"RustdeskShare" device in "approved only" mode, and add the OIDC client.

## Testing

- Unit tests for the policy (copied and extended from `policy.test.ts`),
  link checks and the RustDesk name format.
- End-to-end against a local CortenDesk container and the RustDesk test
  device images from the fork's `.e2e` setup (`rd-testdevice:2mon` for two
  screens), in both access modes:
  - preview thumbnails
  - guest connects without a click
  - a view-only link rejects input sent by a modified client
  - the display limit holds
  - ending a link disconnects the guest
  - an expired link is refused
  - the RustDesk name shows label, guest name and IP
- Not testable headless: RustDesk's own window showing the name. The test
  checks the `my_name` the device receives instead.

## Left to the builder

The web framework, the OIDC library, the SQLite driver, the code layout,
styling (follow CortenDesk's look where the web client is reused), English
and Dutch text, and how the guest page and admin pages are built.

## Decisions made while building (2026-11-06)

- **Service account:** a normal console user that only sees the devices to
  share is recommended over an admin. Password sign-in is the default; if the
  console refuses it (local login disabled for SSO, 2FA required), the admin
  page offers the client OIDC flow (`/api/oidc/auth` + `auth-query`), whose
  token lasts 30 days.
- **No heartbeat or sysinfo:** `/api/login` already registers the sidecar's
  RustDesk ID as a device, which is enough for "approved only" mode.
- **Preview:** a probe connection reads the display list, then each screen is
  shown as a live tile (an iframe of the guest viewer on a short-lived,
  view-only preview link for that display). Tiles close after a minute or
  when the link is made.
- **Viewer code base:** the web client from the fork's
  `feature/share-links-gateway` branch, which already has the gateway mode.
