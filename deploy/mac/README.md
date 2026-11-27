# Running the hub on a Mac

The hub can run on a Mac instead of a Linux VM: the same gateway, router and one engine per person,
started by launchd. The Mac has to stay on, awake and online.

## Layout

Everything lives under one root folder, set with `JH_HUB_ROOT` (default `~/kindahired-hub`). The
owner's hub uses `/Volumes/Cache/kindahired`:

```
<root>/
  code/     your working copy of the repo (where changes are made; optional)
  app/      a separate clone on branch hub that the live hub runs from
  bin/      node and cloudflared, the only programs the services run
  hub/      people.json, gateway.env, router.env, hub.env, tunnel-token (all mode 600)
  people/   one data folder per person (mode 700)
```

Outside the root there are only the launchd plists (`~/Library/LaunchAgents/dev.kindahired.*.plist`)
and launchd's own logs (`~/Library/Logs/kindahired/`), because launchd itself can't open files on an
external drive.

## External drives and Full Disk Access

macOS won't let a background service read or write an external drive unless the program has Full
Disk Access. A shell started by launchd is refused too, so the services never use one: each runs
`<root>/bin/node` or `<root>/bin/cloudflared` directly, and those two binaries are the only ones
given Full Disk Access. A dedicated copy of node keeps the permission away from the node you use
for everything else. On the internal drive none of this is needed.

## Set up

1. Make the folders and the dedicated node:

   ```bash
   export JH_HUB_ROOT=/Volumes/Cache/kindahired
   mkdir -p $JH_HUB_ROOT/{bin,hub,people} && chmod 700 $JH_HUB_ROOT/hub $JH_HUB_ROOT/people
   cp "$(which node)" $JH_HUB_ROOT/bin/node
   ```

2. Clone the app and install:

   ```bash
   git clone <repo url> $JH_HUB_ROOT/app && cd $JH_HUB_ROOT/app && git checkout hub && npm ci && npx playwright install chromium
   ```

3. Write the env files from the templates and fill them in (owner checklist, sections 5 to 7):

   ```bash
   cd $JH_HUB_ROOT/app
   cp deploy/hub/gateway.env.template $JH_HUB_ROOT/hub/gateway.env
   cp deploy/hub/router.env.template  $JH_HUB_ROOT/hub/router.env
   cp deploy/hub/hub.env.template     $JH_HUB_ROOT/hub/hub.env
   chmod 600 $JH_HUB_ROOT/hub/*.env
   ```

   Generate the gateway secret once with `openssl rand -hex 32` and set it as
   `HUB_GATEWAY_SECRET=` in both `gateway.env` and `hub.env` (the same value). The gateway won't
   start without it, and in hub mode an engine refuses every request that doesn't carry it.

4. Cloudflare Tunnel. Download cloudflared into `bin/`, save the tunnel token to `hub/tunnel-token`
   (mode 600), and run it as a launchd service that reads the token from that file
   (`cloudflared tunnel --no-autoupdate --logfile <root>/logs/cloudflared.log run --token-file <root>/hub/tunnel-token`).
   Its public hostname points at `http://localhost:8080`.

5. Give **Full Disk Access** to `<root>/bin/node` and `<root>/bin/cloudflared` (System Settings →
   Privacy & Security → Full Disk Access → +, then Cmd+Shift+G to paste the path).

6. Add people, then write and start the services:

   ```bash
   cd $JH_HUB_ROOT/app
   npm run hub -- add-person <id> <email>
   npm run hub -- mac:install
   ```

   `mac:install` writes a plist for `awake` (caffeinate, keeps the Mac awake on power), `gateway`,
   `router` and each person's engine, and prints the `launchctl bootstrap` commands to run.

7. Point Telegram at the hub:

   ```bash
   cd $JH_HUB_ROOT/app && node --env-file=$JH_HUB_ROOT/hub/router.env --import tsx src/hub/cli.ts telegram:webhook https://<hub domain>/
   ```

8. Check: `curl http://127.0.0.1:8080/healthz` returns `ok`, `launchctl print gui/$(id -u)/dev.kindahired.gateway`
   shows it running, and `tail -f ~/Library/Logs/kindahired/*.log` shows no errors.

## Day to day

- Restart one service: `launchctl kickstart -k gui/$(id -u)/dev.kindahired.<name>`
- Stop one: `launchctl bootout gui/$(id -u)/dev.kindahired.<name>`; start it again with
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.kindahired.<name>.plist`
- Update: `cd $JH_HUB_ROOT/app && git pull && npm ci`, then kickstart each service.
- Remove everything: `npm run hub -- mac:uninstall` prints the commands.

## Moving an existing local setup in

1. Stop the old local daemon (whichever exists):
   `launchctl bootout gui/$(id -u)/local.kindahired.daemon` or `local.jobhunt.daemon`.
2. Copy its data and context into the person's folder:

   ```bash
   cp -R <old>/data/. $JH_HUB_ROOT/people/<id>/
   mkdir -p $JH_HUB_ROOT/people/<id>/context
   cp <old>/context/profile.json <old>/context/playbook.md $JH_HUB_ROOT/people/<id>/context/
   ```

   A `jobhunt.db` is renamed to `kindahired.db` the first time the engine starts.
3. Move personal keys (Gemini, Anthropic, `MY_EMAILS`, Firecrawl, X) from the old `.env` into
   `people/<id>/.env`, the Google client into `hub/hub.env`, and the bot token into `hub/router.env`.
4. Put the person's Telegram chat id in `people.json`:
   `sqlite3 $JH_HUB_ROOT/people/<id>/kindahired.db "select value from kv where key='telegram.chatId'"`.
