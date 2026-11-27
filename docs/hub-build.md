# Hub build spec

The contracts the hub pieces are built against. The plan and costs are in
[desktop-app-plan.md](desktop-app-plan.md).

## Processes on the hub VM

| Process | Listens on | Job |
|---|---|---|
| `gateway` (`src/hub/gateway.ts`) | `127.0.0.1:8080`, exposed only through Cloudflare Tunnel | Sends each request to the right person's engine, and `/telegram/*` to the router |
| `router` (`src/hub/router.ts`) | `127.0.0.1:8090` | Owns the shared bot token. Offers a Bot API stand-in to each engine. |
| `engine@<person>` (today's `src/daemon.ts`) | `127.0.0.1:<port from people.json>` | One per person. `JH_DATA_DIR=/srv/jobhunt/people/<person>` |

All three come from this repo and run under systemd (templates in `deploy/hub/`).

## The people registry: `/srv/jobhunt/hub/people.json`

```json
{ "people": [ {
  "id": "sam",                     // [a-z0-9-], also the data folder name
  "email": "sam@example.com",      // the Cloudflare Access identity
  "port": 4401,                    // that person's engine port
  "relaySecret": "<32 random bytes, hex>",   // the engine's "bot token" toward the router
  "workerToken": "<32 random bytes, hex>",   // the desktop worker's bearer token
  "chatId": null                   // set by the router when the person links Telegram
} ] }
```

`JH_HUB_DIR` overrides `/srv/jobhunt/hub`. `src/hub/people.ts` owns reading and writing it: atomic
writes (write a temp file, then rename), with a CLI to add people (see Gateway below).

## Per-person engine settings

Each engine reads `<JH_DATA_DIR>/.env` when it exists. That's a small change in `config.ts`: after
the repo `.env`, load `DATA_DIR/.env` without overriding variables already set. On the hub, that
file holds the person's own keys (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `MY_EMAILS`, and so on)
plus:

```
JH_HUB=1
TELEGRAM_API_BASE=http://127.0.0.1:8090/relay         # router stand-in for api.telegram.org
TELEGRAM_BOT_TOKEN=<relaySecret>                      # identifies the person to the router
JH_CLAUDE_VIA=worker                                  # Claude Code calls go to the desktop worker
JH_WORKER_TOKEN=<workerToken>
PORT=<port>
```

Settings shared by every engine live in `/srv/jobhunt/hub/hub.env` (template:
`deploy/hub/hub.env.template`), which the engine unit loads before the person's file:

```
GOOGLE_CLIENT_ID=...                                  # the hub's one Google OAuth client
GOOGLE_CLIENT_SECRET=...
JH_PUBLIC_URL=https://<hub domain>/                   # links, and <url>oauth/google/callback
```

systemd lets the later file win, so a person's `.env` can replace these (only for a person on
their own Google client). config.ts never overrides a variable already set, so its own `.env`
loads can't change them.

## Google sign-in on the hub

`src/web/google-connect.ts`, hub mode only. `GET /google` shows the connection (account, scopes,
Calendar) or a Connect button. `POST /oauth/google/start` stores a one-time state in kv (10 minutes)
and redirects to Google with the same scopes as `auth:google`, `access_type=offline`,
`prompt=consent`, `include_granted_scopes=true`. `GET /oauth/google/callback` checks and spends the
state, exchanges the code with the same redirect URI and writes `google-token.json` in the person's
data folder, the file the CLI flow writes. The gateway passes the callback through on the Access
cookie like any other page. The CLI loopback flow is unchanged for local mode.

## Telegram: the router is a Bot API stand-in

`telegram.ts` builds URLs as `${TELEGRAM_API_BASE ?? "https://api.telegram.org"}/bot${token}/${method}`.
Nothing else in the engine changes.

The router:

- **`POST /telegram/webhook`** (reached through the gateway; Cloudflare Access bypasses this path).
  Requires the `X-Telegram-Bot-Api-Secret-Token` header to equal `TELEGRAM_WEBHOOK_SECRET`.
  - It finds the update's chat (`message.chat.id`, or `callback_query.message.chat.id`), looks up
    the person with that `chatId`, and appends the update to that person's queue.
  - A `/start <code>` message from a chat with no owner: the code is a pending link code, so the
    router sets the person's `chatId` in people.json, queues the update for that person, and
    replies "Linked."
  - Anything else from an unknown chat is dropped and logged.
- **`/relay/bot<relaySecret>/<method>`**, for engines only (localhost):
  - `getUpdates {offset, timeout}`: Bot API semantics. Returns that person's queued updates with
    `update_id >= offset`, holding the request up to `timeout` seconds (cap 50) when there are none.
    Updates below `offset` are dropped. Update ids are the router's own counter for that person,
    always increasing.
  - Every other method (`sendMessage`, `editMessageText`, `editMessageReplyMarkup`,
    `answerCallbackQuery`, `sendDocument` as multipart) is forwarded to the real Bot API. **`chat_id`
    is overwritten with the person's `chatId`.** `answerCallbackQuery` has no chat, so it is
    forwarded only if the callback id was delivered to that person. The real response is returned
    as is.
  - A method called before the person has linked returns
    `{ok:false, error_code:400, description:"Telegram not linked"}`.
  - An unknown `relaySecret` returns 401.
- **`POST /relay/bot<relaySecret>/jhLinkCode`** (our extension) returns
  `{ok:true, result:{code, url:"https://t.me/<bot username>?start=<code>"}}`. Codes are single use and
  last 30 minutes.
- **Queue storage:** `hub/router.db`, in SQLite through `node:sqlite`, so updates survive restarts.
  Delivered updates are deleted after 24 hours.
- **Env:** `TELEGRAM_BOT_TOKEN` (the real one), `TELEGRAM_WEBHOOK_SECRET`, `JH_HUB_DIR`, `ROUTER_PORT`.
- **`npm run hub -- telegram:webhook <public url>`** calls `setWebhook` with the secret and
  `allowed_updates: ["message","callback_query"]`.

Engine side, in hub mode:
- The dashboard gets a **Connect Telegram** button. It calls `jhLinkCode`, shows the link, and runs
  the existing `linkChat()` in the background to capture the chat id from the `/start` update.
- `daemon.ts` starts the Telegram loop as soon as the chat is linked, by checking every minute
  instead of only at startup.

## Claude Code through the desktop worker

`src/llm/providers.ts` → `runClaudeCode(args, prompt, timeoutMs)`. With `JH_CLAUDE_VIA=worker`, it
calls `src/worker/queue.ts` → `enqueueClaude(args, prompt, timeoutMs): Promise<ClaudeResult>`
instead of spawning the process.

- **Table** `worker_jobs(id INTEGER PK, args TEXT json, prompt TEXT, status TEXT
  queued|claimed|done|failed, result TEXT json, error TEXT, created_at, claimed_at, finished_at)`,
  created by `queue.ts` itself with `CREATE TABLE IF NOT EXISTS`.
- **No worker seen in the last 3 minutes** (`kv worker.lastSeen`): `enqueueClaude` throws
  `WorkerOfflineError extends PlanUnavailableError`, with the message "Your computer is offline, so
  Claude steps are waiting." The existing pack and summary handling already pauses on
  `PlanUnavailableError` and tells the person once.
- A job claimed but not finished within its `timeoutMs` goes back to `queued`, once, then fails.
- **Endpoints** on the engine's dashboard server, all requiring `Authorization: Bearer
  <JH_WORKER_TOKEN>`:
  - `POST /worker/claim`: a long poll of up to 25 s. Sets `worker.lastSeen`. Returns `{job: {id,
    args, prompt, timeoutMs}}` or `{job: null}`.
  - `POST /worker/complete` with `{id, result}` (a ClaudeResult) or `{id, error, planUnavailable:
    bool}`.
  - `GET /worker/status`: `{queued, claimed, lastSeen}`, for the desktop tray.
  - The routes live in `src/worker/routes.ts`. `server.ts` gets one line that hands `/worker/*` to
    them.
- **Worker client** `src/worker/client.ts`, run with `npm run worker -- --hub <url> --token <t>`, or
  started by the desktop app:
  - Loop: claim, then run `claude` locally, the same way `runClaudeCode` spawns it today (the same
    env scrubbing and empty agent folder), then complete.
  - **Allow-list before running:** the args may only contain the flags `-p`, `--output-format`,
    `--no-session-persistence`, `--strict-mcp-config`, `--setting-sources`, `--model`,
    `--system-prompt`, `--tools`, `--allowedTools`, `--effort` and `--json-schema`. `--tools` and
    `--allowedTools` may only name `WebSearch` and `WebFetch`. Anything else gets
    `{error:"refused args"}` and is never run.
  - **Concurrency:** 1 job at a time by default (`--concurrency`).
  - Backs off for 30 s on network errors.
- The spawn and parse code moves into one shared function, used both by the local path and by the
  worker.

## Gateway

- Every request needs `Cf-Access-Jwt-Assertion`, checked as an RS256 JWT against
  `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (keys cached for an hour) with
  `aud = CF_ACCESS_AUD`. Its `email` claim decides the person, and the request is proxied to that
  person's port.
- **Exceptions:**
  - `/telegram/webhook` goes to the router with no JWT (Access bypass rule).
  - `/worker/*` needs no JWT (Access bypass rule). The bearer token decides the person, and an
    unknown token gets 401.
- It streams request and response bodies, passes `Host`, sets `X-Forwarded-*`, and removes
  `Cf-Access-*` headers before proxying.
- An email that isn't in people.json gets 403 with a plain page: "You're signed in as … but don't
  have a dashboard here yet."
- `GET /healthz` returns 200 with no auth.
- **CLI:** `npm run hub -- add-person <id> <email>` creates the data folder, the `.env` from a
  template, the port (next free from 4401), and both secrets, then prints the systemd command.
  `npm run hub -- list` lists people.

## Quick-step routing

- `JH_QUICK=haiku|gemini` (default `gemini`).
- With `haiku` and `ANTHROPIC_API_KEY` set, quick steps run on `claude-haiku-5-5` through the
  Anthropic SDK. That's `apiStructured` with a model parameter. Quick research
  (`QUICK_RESEARCH`) uses `apiResearch` on Haiku too.
- On an authentication, permission, credit or billing error, Haiku is off for 3 hours and steps
  fall through to Gemini, then Claude Code.
- Quick steps through Claude Code pass `--model haiku` (override with `JH_CLAUDE_QUICK_MODEL`).
  Fit reads and writing keep `JH_CLAUDE_MODEL`.
- `jh status` shows the quick-step provider.

## Rules for every change

- No new runtime dependencies without a strong reason. Node 24 built-ins (`node:sqlite`, `fetch`,
  `crypto`, `http`) cover all of this.
- Tests: `node:test` files in `test/`, following the existing style. `npm run typecheck` and
  `npm test` must pass.
- Comments and docs in the project's plain voice. No tool or assistant attribution anywhere.
