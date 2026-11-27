# Hub setup: Oracle Ubuntu ARM VM

The contracts are in [../../docs/hub-build.md](../../docs/hub-build.md).

1. Create the VM (Ubuntu, ARM, Always Free). Open no inbound ports; Cloudflare Tunnel needs none.
2. Make the user and folders:
   ```
   sudo useradd --system --create-home --shell /usr/sbin/nologin jobhunt
   sudo mkdir -p /srv/jobhunt/{app,hub,people}
   sudo chown -R jobhunt:jobhunt /srv/jobhunt
   sudo chmod 700 /srv/jobhunt/people /srv/jobhunt/hub
   ```
3. Install Node 24:
   ```
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs git sqlite3
   ```
4. Get the code and install:
   ```
   sudo -u jobhunt git clone <repo url> /srv/jobhunt/app
   cd /srv/jobhunt/app && sudo -u jobhunt npm ci
   ```
5. Install Chromium for Playwright and its system libraries:
   ```
   sudo npx playwright install-deps chromium
   sudo -u jobhunt npx playwright install chromium
   ```
6. Install cloudflared (the arm64 .deb from Cloudflare's releases), then:
   ```
   cloudflared tunnel login
   cloudflared tunnel create jobhunt
   cloudflared tunnel route dns jobhunt hub.example.com
   ```
   Copy `cloudflared-config.example.yml` to `/etc/cloudflared/config.yml`, fill it in, then
   `sudo cloudflared service install`.
7. In Cloudflare Zero Trust, add a self-hosted Access application for `hub.example.com` with an
   Allow policy for your people's emails. Add two Bypass policies for the paths
   `/telegram/webhook` and `/worker/*` (see the config example for why). Note the application's
   AUD tag and your team domain.
8. Write the env files (mode 600, owned by `jobhunt`):
   - `/srv/jobhunt/hub/gateway.env`: `CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`,
     `CF_ACCESS_AUD=<aud tag>`, `JH_HUB_DIR=/srv/jobhunt/hub`
   - `/srv/jobhunt/hub/router.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
     `JH_HUB_DIR=/srv/jobhunt/hub`
   - `/srv/jobhunt/hub/hub.env`, copied from `hub.env.template`: `GOOGLE_CLIENT_ID` and
     `GOOGLE_CLIENT_SECRET` (the hub's one Google OAuth client) and `JH_PUBLIC_URL` (the hub's
     address, with a trailing slash). Every engine loads it before the person's own `.env`, so a
     value in a person's file wins; keep these out of person files unless that person uses their
     own Google client. Restart the engines after changing it.
9. Install the units and start the gateway and router:
   ```
   sudo cp deploy/hub/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now jobhunt-gateway jobhunt-router
   ```
10. Add a person, add their keys to the `.env` it prints, and start their engine:
    ```
    sudo -u jobhunt npm run hub -- add-person sam sam@example.com
    sudo systemctl enable --now jobhunt-engine@sam
    ```
11. Point Telegram at the hub:
    `sudo -u jobhunt npm run hub -- telegram:webhook https://hub.example.com/telegram/webhook`
12. Check: `curl https://hub.example.com/healthz` returns `ok`, and signing in at
    `https://hub.example.com/` shows the person's dashboard.
13. Nightly SQLite backup. Add to the `jobhunt` crontab (`sudo -u jobhunt crontab -e`):
    ```
    30 3 * * * for d in /srv/jobhunt/people/*/; do [ -f "${d}jobhunt.db" ] && sqlite3 "${d}jobhunt.db" ".backup '${d}backup-$(date +\%a).db'"; done
    ```
    That keeps seven rolling copies per person. Copy them off the VM as well.

Follow-up: run each engine as its own Linux user for stronger separation (see the note in
`jobhunt-engine@.service`).
