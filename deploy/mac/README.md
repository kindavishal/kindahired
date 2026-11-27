# Hub setup: your Mac (launchd)

The same hub as `deploy/hub/`, run as launchd LaunchAgents instead of systemd units. Contracts are in
[../../docs/hub-build.md](../../docs/hub-build.md). Layout:

```
~/kindahired-hub/
  app/      a separate git clone of this repo on branch hub (never your dev checkout)
  hub/      JH_HUB_DIR: people.json, gateway.env, router.env, hub.env
  people/   JH_PEOPLE_DIR: one folder per person
  logs/     one log per launchd job
```

Labels are `dev.kindahired.gateway`, `dev.kindahired.router` and `dev.kindahired.engine.<id>`. The
gateway runs under `caffeinate -s`, so the Mac stays awake while on power.

1. Create the folders:
   ```
   mkdir -p ~/kindahired-hub/{hub,people,logs} && chmod 700 ~/kindahired-hub/hub ~/kindahired-hub/people
   ```
2. Clone the repo into `app/` and switch to the hub branch:
   ```
   git clone <repo url> ~/kindahired-hub/app
   cd ~/kindahired-hub/app && git checkout hub
   ```
3. Install dependencies and Chromium (Node 24 required; `mac:install` pins whichever `node` runs it):
   ```
   npm ci
   npx playwright install chromium
   ```
4. Write the three env files in `~/kindahired-hub/hub/` (mode 600) from the templates:
   ```
   cd ~/kindahired-hub/app
   cp deploy/hub/gateway.env.template ~/kindahired-hub/hub/gateway.env
   cp deploy/hub/router.env.template  ~/kindahired-hub/hub/router.env
   cp deploy/hub/hub.env.template     ~/kindahired-hub/hub/hub.env
   chmod 600 ~/kindahired-hub/hub/*.env
   ```
   Fill them in: `gateway.env` (Cloudflare Access team domain and AUD), `router.env` (the bot token
   and webhook secret), `hub.env` (the Google client id and secret, and `JH_PUBLIC_URL`). Add
   `JH_HUB_DIR=<your home>/kindahired-hub/hub` to `gateway.env` and `router.env` only if you want it
   explicit; the plists already set it. The env files are sourced by `sh`, so keep values free of
   spaces or quote them.
5. Add the first person (this prints the keys file to fill in and the mac command):
   ```
   cd ~/kindahired-hub/app && npm run hub -- add-person sam sam@example.com
   ```
   On a Mac the default folders are the layout above; no extra variables needed.
6. Install the tunnel. In Cloudflare Zero Trust, create a remotely-managed tunnel for the hub, route the
   hub's hostname to `http://127.0.0.1:8080`, then:
   ```
   brew install cloudflared
   sudo cloudflared service install <token>
   ```
   The token comes from the tunnel's page in the Cloudflare dashboard. It is a secret: paste it
   yourself, and do not share it or commit it. Access policies (Allow list, Bypass for
   `/telegram/webhook` and `/worker/*`) are as in `deploy/hub/cloudflared-config.example.yml`.
7. Write the launchd plists:
   ```
   cd ~/kindahired-hub/app && npm run hub -- mac:install
   ```
   For one person only: `npm run hub -- mac:install --person sam`.
8. Start everything with the `launchctl bootstrap gui/$(id -u) <plist>` lines that step 7 printed. To
   start by hand: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.kindahired.gateway.plist`
   (and `.router`, `.engine.<id>`).
9. Point Telegram at the hub (the token and secret live in `router.env`):
   ```
   cd ~/kindahired-hub/app && set -a && . ../hub/router.env && set +a && npm run hub -- telegram:webhook https://<hub domain>/telegram/webhook
   ```
10. Checks:
    ```
    curl http://127.0.0.1:8080/healthz          # ok
    launchctl print gui/$(id -u)/dev.kindahired.gateway | grep -E "state|pid"
    tail -f ~/kindahired-hub/logs/*.log
    ```
    LaunchAgents run while you are logged in. Turn on automatic login for the Mac's user if it must
    come back after a reboot unattended.

## Updating

```
cd ~/kindahired-hub/app && git pull && npm ci
launchctl kickstart -k gui/$(id -u)/dev.kindahired.gateway
launchctl kickstart -k gui/$(id -u)/dev.kindahired.router
launchctl kickstart -k gui/$(id -u)/dev.kindahired.engine.sam     # one per person
```

Re-run `npm run hub -- mac:install` only if the node binary moved or the plist templates changed
(then `launchctl bootout` and `bootstrap` the changed ones). `npm run hub -- mac:uninstall` prints the
bootout and `rm` commands.

## Moving the owner's existing setup in

Do this after step 5 has created `people/<id>/` for yourself, before step 8.

1. Stop the old local daemon (whichever exists):
   ```
   launchctl bootout gui/$(id -u)/local.kindahired.daemon
   launchctl bootout gui/$(id -u)/local.jobhunt.daemon
   ```
2. Copy the data (the old checkout is `<old>`). `jobhunt.db` is renamed to `kindahired.db` on first start:
   ```
   cp -R <old>/data/. ~/kindahired-hub/people/<id>/
   mkdir -p ~/kindahired-hub/people/<id>/context
   cp <old>/context/profile.json <old>/context/playbook.md ~/kindahired-hub/people/<id>/context/
   ```
3. Split the old repo `.env`. The hub never reads a repo `.env`:
   - Personal keys (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `MY_EMAILS`, and the like) go into
     `people/<id>/.env`, below the lines `add-person` wrote. Do not copy `TELEGRAM_BOT_TOKEN` or
     `PORT` there; the file already has the relay values.
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` go into `hub/hub.env`.
   - `TELEGRAM_BOT_TOKEN` goes into `hub/router.env`.
4. Set your chat id in `hub/people.json` (your entry's `"chatId"`, a number), using:
   ```
   sqlite3 ~/kindahired-hub/people/<id>/kindahired.db "select value from kv where key='telegram.chatId'"
   ```
5. Start the hub (step 8) and check the dashboard. Keep the old checkout until you are happy.
