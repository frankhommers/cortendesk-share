# CortenDesk Share

Share a RustDesk screen with anyone who has a browser, through a secret link.
It runs as its own container next to [CortenDesk](https://github.com/marcpope/cortendesk)
and needs no changes to it.

- **Rights per link, enforced on the server.** You choose watch only, or also
  mouse and keyboard, clipboard, files, sound and chat. The guest's browser
  never talks to the device directly: the sidecar does the RustDesk login and
  passes messages through an allowlist, so a modified browser can't do more.
- **One screen only.** You pick a screen from live previews when you make the
  link. The guest sees that screen and can't switch to another.
- **No Accept click.** With the device password stored (encrypted) in the
  sidecar, guests connect right away. The password never reaches them.
  Without it, the device shows its normal accept window.
- **Clear naming.** The device shows each guest as
  `RustdeskShare · <link label> · <guest name> · <guest IP>`.
- **Admin pages behind OIDC**, limited to a list of email addresses.

Guests need only HTTPS to the sidecar. The sidecar talks to CortenDesk's
public client API and its `/ws/id` and `/ws/relay` WebSocket endpoints.

## Run it

```yaml
services:
  cortendesk-share:
    image: ghcr.io/frankhommers/cortendesk-share:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8090:8090"   # put a TLS reverse proxy in front
    volumes:
      - ./data:/data
    environment:
      SHARE_PUBLIC_URL: https://share.example.com
      SHARE_SECRET_KEY: "<at least 32 random characters, keep it safe>"
      CD_URL: https://rustdesk.example.com
      CD_USERNAME: share-gateway
      CD_PASSWORD: "<the service account's password>"
      OIDC_ISSUER: https://auth.example.com
      OIDC_CLIENT_ID: cortendesk-share
      OIDC_CLIENT_SECRET: "<secret>"
      SHARE_ALLOWED_EMAILS: you@example.com
      TRUSTED_PROXIES: "*"      # the proxy's address, or * if only the proxy can reach the port
```

`./data` must be writable by uid 1000 (`node`).

### One-time setup

1. **Service account in CortenDesk.** Create a normal (non-admin) user, for
   example `share-gateway`, without two-factor authentication. Give it access
   only to the devices you want to share: it sees what that user sees, and
   nothing else. Put its credentials in `CD_USERNAME` / `CD_PASSWORD`.
   If CortenDesk refuses password sign-in (local login disabled for SSO, or
   2FA required), leave them empty and use **Sign the sidecar in with single
   sign-on** on the admin page instead. That token lasts 30 days.
2. **Approve the sidecar device.** The sidecar connects as its own RustDesk
   ID, shown on the admin page. If CortenDesk only lets approved devices start
   sessions, approve that device once.
3. **OIDC client.** Register a client with redirect URI
   `https://<share host>/auth/callback`, scopes `openid email profile`.
4. **Reverse proxy.** Forward HTTPS and WebSocket upgrades (path `/gw`) to
   port 8090.

### Settings

| Variable | Meaning |
|---|---|
| `SHARE_PUBLIC_URL` | Base URL of the sidecar, used in links and the OIDC redirect |
| `SHARE_SECRET_KEY` | Encrypts stored device passwords and signs cookies. Changing it makes stored passwords unreadable |
| `CD_URL` | CortenDesk console base URL |
| `CD_USERNAME`, `CD_PASSWORD` | Service account (optional when signed in through SSO) |
| `CD_WS_ID_URL`, `CD_WS_RELAY_URL` | Override the WebSocket URLs (default: `CD_URL` + `/ws/id`, `/ws/relay`) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES` | Admin sign-in |
| `SHARE_ALLOWED_EMAILS` | Comma-separated emails that may use the admin pages |
| `TRUSTED_PROXIES` | Addresses whose `X-Forwarded-For` is believed, or `*` |
| `SHARE_DEVICE_NAME` | Prefix shown on the device (default `RustdeskShare`) |
| `PORT`, `DATA_DIR` | Default `8090`, `/data` |

## Using it

1. Sign in, pick the device and store its permanent RustDesk password once.
2. Click **Show screens**. Each screen appears as a live preview (it shows on
   the device as `RustdeskShare · preview`). Click the one to share, or
   **All screens**.
3. Choose what guests may do, how long the link works and how many may watch
   at once, then **Create link**. The link is shown once.
4. The guest opens the link, types their name and clicks **Connect**.
5. **Active links** shows who is watching. **End** disconnects them at once.

## Limits

- Devices that require RustDesk 2FA can't be shared.
- Screen numbers follow the device's own order. Make the link right after the
  preview and they match what you saw.
- Terminal and camera connections are never allowed through a share.

## Development

```bash
cd webclient
npm ci
npm test                 # policy tests
npm run build            # guest viewer -> ../public/rdclient
npm run build:server     # sidecar -> ../dist/sidecar.mjs
DEV_LOGIN_EMAIL=you@example.com SHARE_SECRET_KEY=... CD_URL=... node ../dist/sidecar.mjs
```

`DEV_LOGIN_EMAIL` skips OIDC. Use it only on a development machine.

The viewer and protocol code come from the CortenDesk web client
(AGPL-3.0), with the share gateway from the
[share links work](https://github.com/frankhommers/cortendesk/tree/feature/share-links-gateway).

## License

AGPL-3.0. See [LICENSE](LICENSE).
