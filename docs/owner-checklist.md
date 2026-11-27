# What the owner sets up

Each section is a task only you can do: it needs your accounts, payment details or secrets. Do them
in order. Every secret goes straight into GitHub secrets or into a file on the hub. Never paste one
into a chat, an issue or a commit.

Where a step says "send me", it means a value that isn't secret (an IP address, a domain, a team
name).

---

## 1. Apple: signing and notarizing the macOS app

You need the **Account Holder** role on the Apple developer account to create a Developer ID
certificate.

### 1a. Developer ID Application certificate

1. On your Mac, open **Xcode → Settings → Accounts**, select your Apple ID, then click **Manage
   Certificates…**.
2. Click **+**, then **Developer ID Application**. Xcode creates the certificate and puts it in
   your login keychain.

   No Xcode? Use **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority** and save the request to disk. Then upload it at
   [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates)
   as **+ → Developer ID Application**, download the `.cer` and double-click it.
3. Open **Keychain Access → login → My Certificates**. Find **Developer ID Application: <your
   name> (<team id>)** and expand it to check there's a private key under it.
4. Right-click the certificate (not the key), choose **Export…**, and save it as
   `developer-id.p12` with a strong password. Keep that password; it becomes `CSC_KEY_PASSWORD`.
5. Turn it into one line of text for GitHub:

```bash
base64 -i developer-id.p12 -o developer-id.p12.b64
```

### 1b. App Store Connect API key (for notarizing)

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Users and Access →
   Integrations → App Store Connect API → Team Keys**. If asked, request access first.
2. Click **+**. Name it `kindahired-notarize` and set Access to **Developer**.
3. **Download API Key.** You get `AuthKey_<KEYID>.p8`, and Apple lets you download it only once.
4. Note the **Key ID** (in the table) and the **Issuer ID** (above the table).

### 1c. Add the five secrets to GitHub

From the repo folder, with the GitHub CLI signed in:

```bash
gh secret set CSC_LINK < developer-id.p12.b64
```

```bash
gh secret set CSC_KEY_PASSWORD
```

(It prompts for the password; type it there.)

```bash
gh secret set APPLE_API_KEY < AuthKey_XXXXXXXXXX.p8
```

```bash
gh secret set APPLE_API_KEY_ID --body "XXXXXXXXXX"
```

```bash
gh secret set APPLE_API_ISSUER --body "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Then put `developer-id.p12`, the `.b64` file and the `.p8` somewhere safe outside the repo, such
as a password manager, and delete the loose copies.

---

## 2. Where releases are served from

`kindavishal/kindahired` is **private**. The desktop app's auto-update downloads from GitHub
Releases, and it can't read a private repo's releases without a token built into the app, which you
shouldn't ship. Pick one:

- **A. Make `kindahired` public** (Settings → General → Danger Zone → Change visibility).
  Simplest. First check that nothing private is in the git history:

```bash
git log --all -p | grep -iE "api[_-]?key|secret|token|password" | grep -v "process.env\|example\|placeholder" | head
```

- **B. Keep the code private and publish releases to a public repo, `kindavishal/kindahired-releases`
  (recommended).**
  1. Create the repo on GitHub as Public, with a README.
  2. Create a fine-grained personal access token: GitHub → Settings → Developer settings →
     Fine-grained tokens → **Generate**.
     - Repository access: only `kindahired-releases`.
     - Permissions: **Contents: Read and write**.
     - Expiry: 1 year.
  3. `gh secret set RELEASES_TOKEN` and paste the token at the prompt.
  4. Tell me, and I'll point `app.config.json` and the release workflow at that repo.

---

## 3. Name, IDs and icon

1. Check `apps/desktop/app.config.json`:
   - `productName: kindahired`;
   - `appId: com.kindavishal.kindahired` (changing it after the first release breaks updates, so
     decide now);
   - the maintainer line for the Linux package.
2. **Icon:** a 1024 × 1024 PNG with a transparent background. Save it as
   `apps/desktop/build/icon.png`, or send it to me. For the menu bar, a simple black shape on
   transparent at 16 px and 32 px also helps. Otherwise I'll derive one.

---

## 4. The hub: your Mac for now

For now the hub runs on your Mac, behind the same Cloudflare Tunnel, so testers see no difference.
Follow [deploy/mac/README.md](../deploy/mac/README.md): it sets up `~/kindahired-hub`, the launchd
jobs and the tunnel, and moves your own setup in. Keep the Mac on power and logged in; the gateway
runs under `caffeinate -s`. Section 5c (tunnel) is `sudo cloudflared service install <token>` there,
with the token pasted by you from the Cloudflare dashboard.

### Later: move to Oracle Cloud (off the Mac)

The steps below put the hub on an Always Free VM. Do them when you want it off your Mac, then copy
`people/` and `hub/` across (the setup is in `deploy/hub/README.md`).

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (Start for free).
   - **The home region is permanent.** Pick one near you and your testers. Busy regions can run out
     of the free ARM VMs; smaller regions usually have them.
   - A card is checked but not charged for Always Free resources.
2. Optional but recommended: **upgrade to Pay As You Go** (Billing → Upgrade). Always Free resources
   stay free. Oracle may reclaim *idle* Always Free VMs on free-only accounts, and upgraded accounts
   avoid that. Then set a budget alert at $1 (Billing → Budgets) so any charge gets noticed.
3. If you don't have an SSH key yet, make one on your Mac:

```bash
ssh-keygen -t ed25519 -C "kindahired-hub"
```

4. **Compute → Instances → Create instance:**
   - Name: `kindahired-hub`.
   - Image: **Canonical Ubuntu 24.04**, the aarch64 build.
   - Shape: **Ampere → VM.Standard.A1.Flex**, with **4 OCPUs and 24 GB** memory.
   - Networking: the default new VCN, and **Assign a public IPv4 address** (only for SSH; the hub's
     web traffic goes through Cloudflare).
   - SSH keys: paste the contents of `~/.ssh/id_ed25519.pub`.
   - Boot volume: set it to **150 GB** (Always Free includes 200 GB in total).
   - If you see "Out of capacity", try these in order:
     1. **Ask for less:** 2 OCPUs and 12 GB, or even 1 OCPU and 6 GB. Smaller requests fit more
        often, and 2/12 is plenty for 12 people. You can grow the shape later from **Edit → Shape**,
        within the free 4/24.
     2. **Upgrade to Pay As You Go** (step 2). Free-only accounts are served last when ARM capacity is
        tight. Upgraded accounts usually get a VM within minutes, and the A1 shape stays free up to
        4 OCPUs and 24 GB. Set the $1 budget alert first.
     3. **Keep retrying.** Capacity frees up during the day. The **Create** button can be pressed
        again every few minutes.
     4. **Run the hub on your Mac for now.** The same code runs there behind the same Cloudflare
        Tunnel, so testers see no difference. Moving to Oracle later means copying the data folder
        across.
5. When it shows **Running**, copy the public IP and check that you can log in:

```bash
ssh ubuntu@<public ip>
```

6. **Send me the IP.** Either I run the setup in `deploy/hub/README.md` over SSH (you approve the
   commands), or you follow that file yourself.

---

## 5. Cloudflare: domain, tunnel and logins

### 5a. Domain

1. Make a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Add a site** with a domain you own, on the Free plan, and switch the domain's nameservers at
   your registrar to the two Cloudflare gives you. Or buy a domain in **Domain Registration**,
   which costs about $10–15 a year.
3. Choose the hub's hostname, for example `kindahired.kindavishal.dev`, and **send it to me**.

### 5b. Zero Trust team

1. Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com) and pick a **team name**. Your
   team domain becomes `<team>.cloudflareaccess.com`.
2. Choose the **Free** plan (up to 50 users). It may ask for a card even on Free.
3. **Settings → Authentication → Login methods:** make sure **One-time PIN** is on. Testers then sign
   in with a code emailed to them.
4. **Send me the team domain.**

### 5c. Tunnel (after the VM exists)

1. **Networks → Tunnels → Create a tunnel → Cloudflared**, named `kindahired-hub`.
2. For the environment, choose **Debian, arm64 (64-bit)**, then copy the install command it shows
   and run it on the VM over SSH. The tunnel turns **Healthy**.
3. **Public hostname:**
   - Subdomain: `hub`, on your domain.
   - Service type: **HTTP**.
   - URL: `localhost:8080`.

### 5d. Access applications

Create three self-hosted applications in **Access → Applications → Add an application →
Self-hosted**:

| Application name | Domain and path | Policy |
|---|---|---|
| `kindahired dashboards` | `kindahired.kindavishal.dev` (no path) | Action **Allow**; Include **Emails**: you and each tester |
| `kindahired telegram webhook` | `kindahired.kindavishal.dev` with path `telegram/webhook` | Action **Bypass**; Include **Everyone** |
| `kindahired worker` | `kindahired.kindavishal.dev` with path `worker/` | Action **Bypass**; Include **Everyone** |

The bypass paths are safe:
- Telegram calls carry a secret header the router checks.
- Worker calls carry each person's worker token, which the gateway and engine both check.

When the first application is saved, open it → **Overview** and copy the **Application Audience
(AUD) Tag**. It goes into the hub's `gateway.env` as `CF_ACCESS_AUD`, with `CF_ACCESS_TEAM_DOMAIN`
set to your team domain (step 8 of `deploy/hub/README.md`).

---

## 6. Telegram: the shared bot

1. **Pick the bot.** Using your current one is fine, but only one thing can read a bot at a time:
   - Stop your local copy before the hub takes it over:

```bash
launchctl unload ~/Library/LaunchAgents/local.kindahired.daemon.plist
# If you installed it before the rename to kindahired, the old name is:
launchctl unload ~/Library/LaunchAgents/local.jobhunt.daemon.plist
```

   - Your data moves to the hub as the first person (I'll do this with you). Copying `data/` into
     `/srv/kindahired/people/<you>/`, and `context/profile.json` and `playbook.md` into its `context/`
     folder, is enough. Then your chat id goes into `people.json`, so the router knows your chat.
2. **Make it presentable:** in Telegram, open **@BotFather** and send:
   - `/setname` for the name testers see;
   - `/setdescription` for what it does, plus "invite only";
   - `/setuserpic` (optional).
3. **Get the token:** @BotFather → `/mybots` → your bot → **API Token**. If it was ever shared
   anywhere, use **Revoke current token** first.
4. **On the VM**, put the token in `/srv/kindahired/hub/router.env` as `TELEGRAM_BOT_TOKEN`, along with
   a webhook secret made with:

```bash
openssl rand -hex 32
```

   That's step 8 of `deploy/hub/README.md`. The webhook is set in step 11.

---

## 7. Google Cloud: one OAuth client for everyone

1. At [console.cloud.google.com](https://console.cloud.google.com), create a project named
   `kindahired`.
2. **APIs & Services → Library:** enable the **Gmail API**, **Google Calendar API**, **Google Sheets
   API** and **Google Drive API**. The code asks for `gmail.readonly`, `calendar.readonly`,
   `spreadsheets` and `drive.file`.
3. **Google Auth Platform → Branding:**
   - App name `kindahired`, with your support email and developer contact email.
   - Add your domain under Authorized domains.
   - Google asks for a homepage and a privacy policy link. A short page on the hub domain is enough;
     I can write it.
4. **Audience:**
   - User type **External**.
   - Then **Publish app**, so the publishing status shows **In production**.
   - **Do not** submit for verification. The console will say verification is needed; ignore it.
     Unverified, up to 100 people can sign in, each clicking past the "Google hasn't verified this
     app" screen once.
   - Don't leave it in **Testing**: there, sign-ins expire every 7 days.
5. **Data access:** add the four scopes from step 2.
6. **Clients → Create client:**
   - Type **Web application**, named `kindahired hub`.
   - Authorized redirect URI: `https://kindahired.kindavishal.dev/oauth/google/callback`. It must match
     `JH_PUBLIC_URL` in `hub.env` plus `oauth/google/callback`, exactly.
   - Copy the **client ID and client secret** straight into `/srv/kindahired/hub/hub.env` on the VM
     (start from `deploy/hub/hub.env.template`; mode 600, owned by `kindahired`), as
     `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, next to `JH_PUBLIC_URL`. Not into chat. Then
     restart the engines. Each person connects from **Connect Google** on their Home page (`/google`).
7. **Check the current rules** in Google's help page "Unverified apps", for apps requesting
   restricted scopes in production. If Google now blocks unverified restricted-scope apps, tell me:
   the fallback is each person using their own client.

---

## 8. Anthropic's terms

Read the current **Consumer Terms** and **Usage Policy** at
[anthropic.com/legal](https://www.anthropic.com/legal), and Claude Code's documentation on
authentication and usage.

The setup keeps each tester's Claude Code on **their own computer, signed in by them**, driven by
an app they installed, the same model genmotion uses. The hub never sees or stores Claude
credentials.

Decide whether you're comfortable before inviting anyone. If anything reads as a problem, testers
can switch to their own API key (`ANTHROPIC_API_KEY` in their hub settings), which needs no
subscription at all.

---

## 9. Testers

For each person:

1. Get their email: the address they'll sign in to Cloudflare with, and ideally their Gmail.
2. Add it to the **`kindahired dashboards`** Access policy (step 5d).
3. On the VM:

```bash
sudo -u kindahired npm run hub -- add-person <id> <email>
```

4. Have them send you their **Gemini key**, or their **Anthropic API key** for Haiku, so you can add
   it to their `.env`. Better: once the setup pages exist, they enter it themselves.
5. Start their engine:

```bash
sudo systemctl enable --now kindahired-engine@<id>
```

6. Send them the note below.

### Note to send testers

> Hi! You're invited to try kindahired, my job-search assistant.
>
> **How it works:** a small server I run reads your job-alert email (read-only), watches job boards,
> and keeps track of every follow-up. It pings you on Telegram. Packs, meaning the fit read, a
> tailored resume, a cover note and people to contact, are written by Claude Code on **your own
> computer** with **your own Claude plan**, through a desktop app. It never applies, sends a message
> or follows up for you.
>
> **What I can see:** your data lives on my server: the roles it finds, your tracker, drafts, and
> what it reads from job-related email. As the person running it, I can technically read all of
> that. I won't, but you should know. You can export or delete your data at any time; just ask.
> Your Claude login never leaves your computer.
>
> **To start:**
> 1. Open <hub address>, sign in with the code emailed to you.
> 2. Connect Gmail. Google shows "this app isn't verified" because it's a private tool: click
>    Advanced, then Go to kindahired.
> 3. Connect Telegram from the Home page.
> 4. Install Claude Code and sign in (claude.com/claude-code), then install the desktop app from the
>    Desktop app page and paste the two values it shows.
>
> Reply with anything confusing; that's what testing is for.
