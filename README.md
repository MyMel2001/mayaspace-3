# MayaSpace

**A mid-2000s MySpace clone, federated over ActivityPub.**

Tom never called back, so MayaSpace built its own Top 8: profiles with custom CSS themes,
glittery gradients, a scrolling marquee, image posts, YouTube auto-embeds, friend requests,
alerts — and a full fediverse bridge, so `alice@yourinstance.example` can follow and be
followed by Mastodon, Misskey, GoToSocial, and friends.

```
★ MayaSpace — A place for friends. ★ Now federating with the entire fediverse ★
```

---

## Quick start

```sh
npm install
cp .env.example .env        # then edit values (see below)
sh run-bg.sh                # starts in the background, logs to ./logs/mayaspace-<unix-ts>.log
```

Then open <http://localhost:3414>. Health check: `/healthz`. Stop with
`pkill -f tsx src/index.ts` (or `kill $(lsof -ti :3414)`).

Fore-ground dev with auto-restart: `npm run dev`.

> **Node requirement:** Node.js ≥ 22 (tested on 24). The app uses the
> `Temporal` API (behind Node's `--harmony-temporal` flag, wired into all
> scripts) because Fedify v2 vocabulary uses `Temporal.Instant`.

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAYA_URL` | `http://localhost:3414` | **Canonical public origin** — every actor/note IRI is minted from it. Must be reachable by remote servers for federation. |
| `PORT` | `3414` | HTTP port. |
| `SITE_NAME` / `SITE_TAGLINE` | `MayaSpace` / `A place for friends.` | Shown in the topbar/marquee/footer + NodeInfo. |
| `SESSION_SECRET` | — (dev: ephemeral) | ≥ 32 chars; **required in production**. |
| `ADMIN_HANDLES` / `MODERATOR_HANDLES` | — | Comma-separated handles. **Anyone who registers one of these handles is auto-promoted** to admin/moderator at registration (and re-promoted at each login). |
| `DB_PATH` | `./data/mayaspace.db` | Quick.DB (better-sqlite3) database. |
| `UPLOAD_DIR` | `./data/uploads` | Processed image files. |
| `MAX_UPLOAD_MB` | `10` | Per-file upload limit (pre-compression). |
| `ATTACHMENTS_PER_POST` | `4` | Max images per post (1–12). |
| `POST_MAX_CHARS` / `COMMENT_MAX_CHARS` | `10000` / `3000` | Text limits. |
| `COOKIE_SECURE` | `auto` | `auto` = secure cookies iff `MAYA_URL` is https. |
| `TRUST_PROXY` | `0` | Express `trust proxy` hops (set `1` behind nginx/Caddy). |
| `LOG_LEVEL` | `info` (prod) / `debug` | LogTape level (`debug`, `info`, …). |

### Spinning up an admin

1. Put `ADMIN_HANDLES=admin` in `.env`.
2. Start the server and register the handle `admin` at `/register`.
3. Done — the account gets the `admin` role automatically.

## Features

**MySpace essentials**

- Profiles with **custom CSS themes** and an accent color. The CSS sanitizer
  allowlists ~60 harmless properties and re-serializes every declaration, so
  `@import`, `behavior:`, `url(javascript:…)`, expression(), braces-injection,
  and `</style>` breakouts are all impossible — the "Samy is my hero" worm
  could not reproduce here. (See [`src/security/sanitize.ts`](src/security/sanitize.ts).)
- **Top 8 friends** grid, friend requests with accept/decline, pending lists.
- The obligatory scrolling marquee. No, it can't be turned off. Yes, that's on purpose.

**Posts**

- Rich text posts (sanitized HTML: bold/italic/links/images only), comments,
  star-likes (★, of course), friends-only visibility, @mentions with notifications.
- **Image attachments** — JPEG/PNG/WebP/GIF/AVIF up to `MAX_UPLOAD_MB`, validated
  with sharp (real decode, dimension caps), **re-encoded to WebP q80 (EXIF/metadata
  stripped)** with 320px thumbnails.
- **Automatic embeds** — paste a YouTube / Vimeo / Dailymotion / SoundCloud /
  Bandcamp link and a player appears below the post (server-generated iframes,
  CSP `frame-src` allowlist; the raw link is also left clickable).

**Fediverse (ActivityPub via [Fedify](https://fedify.dev/))**

- WebFinger, NodeInfo 2.1, actor/notes documents, followers/following/outbox/liked
  collections, inbox with shared inbox.
- Inbound: `Follow` (+auto `Accept`), `Create` (note mirroring, reply threading),
  `Like`, `Announce`, `Undo`, `Delete` (tombstones), `Update`.
- Outbound: `Follow`/`Undo(Follow)` any remote actor from `/fediverse`,
  `Create(Note)` fan-out to followers, `Like`/`Undo(Like)` remote posts,
  `Delete` on moderation.
- Deliveries go through a **persistent SQLite-backed queue** (`@fedify/sqlite`) with retries.
- Mirrored remote posts appear in the `/fediverse` feed with a ᶠᵉᵈ badge; remote
  profiles resolve by handle (`user@server`) or URL.

**Plumbing**

- All storage in **Quick.DB** (better-sqlite3 driver) across 13 tables.
- **In-process async scheduler** (overlap-guarded, unref'd timers): orphan
  attachment purge every 6 h, notification pruning every 24 h; admins can
  trigger jobs from the admin panel.
- Structured logging via LogTape to stdout; `run-bg.sh` captures it in
  `./logs/mayaspace-$(date +%s).log`.

## Security model

Every user-input form is defended:

- **XSS:** all bodies/bios/comments are sanitized server-side
  (sanitize-html allowlists); display names/mentions are escaped at render;
  remote content is re-sanitized on ingest. CSP bans inline `<script>`
  outright (`script-src 'self'`).
- **CSRF:** per-session token (32 bytes, `timingSafeEqual`) required on every
  POST, including login/register.
- **Sessions:** SQLite-backed store, HttpOnly + SameSite=Lax cookies, session
  regeneration on login, 14-day rolling expiry.
- **Passwords:** scrypt with per-user random salt; dummy verify on unknown
  handles (timing defense).
- **Rate limits:** global 300/min, auth 25/15 min, posts 15/min, uploads 20/min.
- **Uploads:** MIME allowlist + sharp re-encode (strips polyglot payloads),
  randomized filenames, strict `/media` name validation, `X-Content-Type-Options`
  via helmet, images never served from user-controlled paths.
- **SSRF:** Fedify's private-address fetch guard is left enabled.
- Headers: helmet with strict CSP (inline `<style>` allowed for themes only),
  `frame-ancestors 'self'`, `form-action 'self'`.

## Project layout

```
run-bg.sh              # 1-line background launcher w/ timestamped logs
.env / .env.example    # configuration (admins/mods, secrets, limits)
src/
  index.ts             # entry: logging → store → federation → scheduler → HTTP
  app.ts               # express assembly + getFederation() context provider
  config.ts            # validated env parsing
  store.ts             # Quick.DB wrapper (13 tables)
  scheduler.ts         # in-process async background jobs
  types.ts             # records + view models
  util.ts logger.ts
  security/            # auth middleware, CSP, HTML/CSS sanitizers
  services/            # users, friends, posts, attachments, embeds, render…
  fediverse/           # fedify federation, key pairs, remote actor cache
  web/                 # helpers, multer wiring, 8 route modules
views/                 # EJS templates (retro MySpace look)
public/                # css / js / favicon
data/ logs/            # runtime state (gitignored)
```

## Scripts

| Command | What it does |
| --- | --- |
| `sh run-bg.sh` | Start in background → `./logs/mayaspace-<unixts>.log` |
| `npm start` | Foreground start |
| `npm run dev` | Foreground with restart-on-change |
| `npm run build` | `tsc` → `dist/` |
| `npm run typecheck` | Strict typecheck |

## Testing federation for real

`MAYA_URL` must be a public https URL (or use a tunnel) for other servers to
reach your actors. Once public:

- `curl https://your.host/.well-known/webfinger?resource=acct:alice@your.host`
- Follow `@alice@your.host` from any Mastodon account.
- From MayaSpace: `/fediverse` → look up `someone@some-server` → **Follow** —
  their new posts mirror into `/fediverse` and likes flow back.

## License

SPL-R5
