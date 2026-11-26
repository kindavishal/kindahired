# Desktop app: plan

Status: plan only, nothing built. Written 2026-11-26.

## The problem it solves

Today, setup takes about 20 minutes in a terminal: clone the repo, install Node 24, copy `.env`,
create a Google Cloud OAuth client, make a Telegram bot, run six `npm run jh -- …` commands, then
write a launchd plist. That's fine for the author, but nobody else gets through it. The desktop app
keeps the engine as it is and replaces the terminal with an installer, a setup wizard and a
menu-bar app.

What stays the same: one Mac, local SQLite, the tool prepares and the person acts, Gmail stays
read-only, and the dashboard makes no outside requests.

## What the person gets

- **A `.dmg`** they drag to Applications. Signed and notarized, so macOS opens it with no warnings.
- **A setup wizard** on first launch, one screen per connection, each with a **Test** button.
- **A menu-bar icon** that keeps the engine running when the window is closed: a status dot,
  today's count of due actions, **Open dashboard**, **Pause for today** and **Quit**.
- **The dashboard as the main window.** It's the current server-rendered UI, unchanged, loaded
  from `127.0.0.1`.
- **Native notifications** for urgent pings, alongside Telegram or in place of it.
- **Auto-update** from GitHub Releases.

## Architecture

```
JobHunt.app (Electron)
├── main process: window, menu-bar tray, login item, power-save blocker, Keychain, updater
├── utility process: today's daemon (src/daemon.ts) bundled as one JS file
│     ├── HTTP dashboard on 127.0.0.1:<free port>   ← the BrowserWindow loads this
│     ├── node:sqlite  → ~/Library/Application Support/JobHunt/jobhunt.db
│     ├── Playwright   → LinkedIn profile, page scans, resume PDFs
│     └── AI routing   → Gemini (quick steps) · Claude (fit reads, writing)
└── setup wizard: a few extra dashboard routes (/setup/*), same HTML-first style
```

### Why Electron (and not Tauri or a native Swift app)

The engine is Node/TypeScript and needs Node 24 (`node:sqlite`), Playwright and a Chromium.
Electron ships Node and Chromium together, so the daemon runs unchanged in a utility process.
Tauri would still need Node bundled as a sidecar (40–90 MB), which takes away its size advantage,
and adds a Rust layer. A Swift app means rewriting the shell and still bundling Node. Electron is
the only option that moves the code without a rewrite.

Cost: the app is large, about 250 MB installed, plus a Chromium for Playwright (below).

### Code changes the engine needs

| Today | In the app |
|---|---|
| `config.ts` reads `.env` from the repo root, and data lives in `./data` | Settings come from a JSON file in Application Support; secrets come from the Keychain through Electron `safeStorage`. `JH_DATA_DIR` points at `~/Library/Application Support/JobHunt`. |
| `context/profile.json` and `playbook.md` are edited by hand | A **Profile** page and a **Playbook** page in the dashboard (form plus Markdown editor), stored in the data dir |
| `npm run jh -- auth:google`, `telegram:link`, `linkedin:login`, `import`, `evidence:build` | Wizard steps that call the same functions over a small internal API |
| `service:install` writes a launchd plist with `caffeinate -s` | `app.setLoginItemSettings({ openAtLogin: true })` and `powerSaveBlocker.start("prevent-app-suspension")` while on power |
| Spawns the `claude` CLI from `PATH` | Finds Claude Code at known install paths, with a manual path in settings (see the Claude section below) |
| `chromium.launch()` uses Playwright's downloaded browser | Uses the person's installed Google Chrome (`channel: "chrome"`) when present. Otherwise it downloads Playwright's Chromium (about 170 MB) on first run, with progress shown. |
| Logs go to `data/logs` | Same, plus **Help → Reveal logs** and **Copy diagnostics** (versions and connection status, never tokens or mail) |

The CLI stays for developers. Both the app and the CLI read the same settings layer.

Check first: the Node version inside the current Electron release must include `node:sqlite`.
That's Node 22.5+ with a flag, or 24 without one.

## Install and setup, as the person sees it

**0. Download** `JobHunt.dmg` (about 120 MB compressed), drag it to Applications, and open it.

**1. Welcome.** What it does, what it never does (apply, send or follow up for you), and what stays
on the Mac.

**2. You.** Name, location, target roles, portfolio link and resume facts. This writes the
profile. A **Start from my resume** button reads a PDF and fills in the form.

**3. Playbook.** Starts from the example, with the bracketed parts turned into fields: where you can
work, your tone, what to skip.

**4. AI.** Two choices, explained in plain words with what each costs:
- **My Claude plan (recommended).** Needs Claude Code installed and logged in. The wizard checks
  for it, links the installer if it's missing, and runs a one-word test.
- **An Anthropic API key.** Pay per use, with a monthly cap you set. The key goes in the Keychain.

Then, optionally, a **free Gemini key** for fast screening, with a link to AI Studio and a test
call. Without one, screening runs through Claude and the 90-day backfill is skipped.

**5. Gmail and Calendar.** See "Google sign-in" below. Today this is the hardest step.

**6. Tracker sheet (optional).** Paste a Google Sheet link to import from and mirror to.

**7. Phone pings.** Choose Telegram, Mac notifications only, or both. For Telegram, the wizard walks
through @BotFather with screenshots, takes the token, then shows **Send /start to your bot** and
links the chat automatically.

**8. LinkedIn (optional).** Opens a browser window, the person logs in, and the window closes.

**9. Extras (optional).** Firecrawl key, X API keys with a monthly dollar cap, and target companies.

**10. Done.** Runs the first Gmail sync and the evidence build with a progress bar, then opens
today's list.

Every step can be skipped and finished later from **Settings → Connections**, which shows the
same status as `jh status` today.

## Google sign-in: the real blocker

`gmail.readonly` is a **restricted** Google scope. To ship one OAuth client inside the app for
everyone, Google requires app verification and a yearly third-party security assessment (CASA)
before more than 100 users can sign in. Until that's done, the consent screen shows "unverified
app", and only test users the developer adds by hand can sign in.

Plan, in stages:

1. **Beta (up to 100 people):** ship the app's own OAuth client in "Testing" mode and add each
   beta user's address to the test-user list. Users see the unverified-app screen once.
2. **Fallback for anyone:** keep "bring your own Google Cloud client" as an advanced option, with
   a wizard that deep-links each Console page. This is today's flow, guided.
3. **Public release:** go through verification and CASA (cost below), or drop Gmail API access
   for an alternative: forwarding alerts to a per-user address, or IMAP with an app password.
   Both are worse for privacy and reliability, so verification is the better route if the app
   grows.

Calendar (`calendar.readonly`) and Sheets are "sensitive", not restricted. They need verification
but no CASA.

## Claude: the second dependency

The default mode drives the person's own Claude Code install on their own Claude plan, through
`claude -p`. That works for a personal tool. Before distributing an app built around it:

- **Check Anthropic's terms for third-party apps that use a person's Claude subscription.** The
  safe design is the one the code already uses: the app never handles Claude credentials. It runs
  the Claude Code that the person installed and logged in to themselves. Bundling Claude Code or
  the Agent SDK and offering a claude.ai login inside the app is a different thing, and needs
  Anthropic's approval.
- **The API-key mode is the fallback** that needs no such check. It's already built (`JH_AI=api`),
  so the wizard only has to offer it.

## What it costs the person

| Item | Needed? | Cost |
|---|---|---|
| The app | Yes | Free (price not decided, see Open questions) |
| A Mac that stays on and awake | Yes | Already owned. LinkedIn needs a logged-in browser, so this stays local. |
| Claude plan, for fit reads and writing | One of these two | Pro is about $20 a month and is enough for a few packs a day. Heavy use (10+ packs a day plus research) can hit limits, which Max ($100 or $200 a month) lifts. *Check current prices on claude.com before publishing.* |
| …or an Anthropic API key | One of these two | Pay per use. Estimates below. |
| Gemini key, for quick steps | Optional, recommended | Free tier, about 15 requests a minute and a few hundred a day. On the free tier, Google may use what's sent to improve its products. Say so in the wizard. |
| Google Cloud, Telegram | Yes and optional | Free |
| Firecrawl | Optional | Free plan, 1,000 credits a month |
| X API | Optional | Pay per use, capped by the person. The default cap is $15 a month. |

**API-mode estimates** (Claude Opus 5.5 at $4 per million input tokens and $20 per million output,
cache reads $0.20; figures to check against real `llm.call` usage logs before publishing):

- **One pack** (fit read, resume, cover note, form answers, people research, DMs): roughly
  150–250K input and 25–40K output tokens across the steps, so **about $1–2 a pack**, plus web
  search fees for the research steps.
- **A hiring brief:** about $0.30–0.80.
- **Email screening:** free with Gemini. On the API it could run on Claude Haiku 5.5 ($0.10 / $0.50
  per million), which comes to cents a month. That's worth adding as the API-mode quick model.
- **A typical month** (3 packs a weekday, a few briefs): **about $70–150**. For anyone building
  that many packs, the Claude plan is cheaper, so the wizard should recommend it and show the
  person a running monthly total and a hard cap in API mode.

## What it costs to ship (developer side)

| Item | Cost |
|---|---|
| Apple Developer Program (signing and notarization) | $99 a year |
| GitHub Releases for downloads and auto-update | Free |
| Google OAuth verification (sensitive scopes) | Free, takes days to weeks |
| CASA security assessment for `gmail.readonly` | Yearly. Roughly $500 to several thousand dollars depending on the assessor and tier; get quotes. Only needed past 100 users. |
| A privacy policy and homepage on a domain (Google requires both) | About $15 a year for the domain; hosting can be free |
| Windows build later (code-signing certificate) | About $200–400 a year, if it ever happens |

## Build order

1. **Settings layer.** Move `.env` and `context/` behind one settings module with Keychain-backed
   secrets and an Application Support data dir. The CLI uses it too. Tests keep passing. *About 2 days.*
2. **Electron shell.** Main process, a utility process running the daemon, a window loading the
   dashboard, the tray, a login item, and the power-save blocker. Unsigned dev build. *About 3 days.*
3. **Browser handling.** Use the installed Chrome when there is one, download Chromium on first
   run otherwise, and keep the LinkedIn profile in the data dir. *About 1 day.*
4. **Setup wizard and Connections page.** The ten steps above, each reusing an existing command's
   function. *About 5–7 days; Telegram and Google take the longest.*
5. **Profile and Playbook editors**, with **Start from my resume**. *About 2 days.*
6. **Native notifications, the cost meter and the API cap** for API mode, and Haiku 5.5 for quick
   steps on the API. *About 2 days.*
7. **Migration.** On first launch, if a repo `data/` folder or a launchd plist exists, offer to
   import it and remove the old login item. *About 1 day.*
8. **Packaging.** electron-builder DMG, signing, notarization, auto-update, and a CI release
   workflow. *About 2 days.*
9. **Private beta** with Google in Testing mode, for up to 100 people. Fix what breaks.
10. **Public release:** Google verification and CASA, a homepage, and a privacy policy.

That's about 3–4 weeks of work to a private beta. The public release depends on Google's review
time.

## Risks

- **Google's restricted scope** is the slowest, least predictable step. Start verification early.
- **Claude subscription use** by a distributed app needs checking against Anthropic's terms (see above).
- **LinkedIn automation** runs through the person's own login at browsing pace, as it does today.
  LinkedIn's terms still restrict automated access, so the wizard should say plainly that it's
  optional and at the person's own risk.
- **App size** (about 250 MB plus Chromium) is normal for Electron, but worth stating on the
  download page.
- **The Mac has to stay on.** Overnight alerts wait while it sleeps, as they do now. A hosted
  version would remove this, but means Postgres, a per-user browser and hosting costs, which is
  out of scope.

## Open questions

1. **Price:** free and open source, or a one-time price to cover Apple and CASA costs?
2. **Telegram:** keep it as the default phone channel, or lead with Mac notifications and make
   Telegram an add-on?
3. **Windows and Linux:** wanted, or macOS only? The engine is portable; only the shell and the
   login item differ.
4. **Gemini vs Haiku for quick steps:** Gemini is free but Google may use the data; Haiku costs
   cents but needs an API key. Which should the wizard recommend first?
