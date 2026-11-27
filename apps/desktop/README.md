# Desktop app

A menu bar (tray) app for macOS and Linux. It runs the worker from `src/worker/client.ts`: it takes
Claude Code steps from the person's hub, runs them on this computer with their own `claude`, signed
in to their own Claude plan, and sends the answers back. It also opens the hub's dashboard in a
window and keeps itself up to date. The plan is in [docs/desktop-app-plan.md](../../docs/desktop-app-plan.md)
and the worker's contract in [docs/hub-build.md](../../docs/hub-build.md).

It has its own `package.json`; nothing here is added to the repo's root dependencies.

## What it does

- **First run** opens the dashboard window on the built-in hub (`hubUrl` in `app.config.json`), where
  the person signs in with the email code. Once a hub page has loaded, the app runs
  `POST /desktop/pair` from that page (same origin, with the `x-kindahired-app: 1` header) and keeps
  the worker token it gets back. If Claude Code is missing or signed out, the small settings window
  opens to help with that. Nobody copies a hub address or a token.
- **Testing against another hub:** `npx electron . --hub=http://localhost:8080 --user-data-dir=/tmp/kh-dev`.
- **Links:** `kindahired://open/<path>` opens that dashboard page in the app (only paths on the hub).
  The dashboard's requests carry `kindahired-app/<version>` in the user agent, so the hub can tell
  the app from a browser.
- **Where things are kept:** the token is encrypted with Electron `safeStorage` (the macOS Keychain,
  or GNOME Keyring / KWallet on Linux) in `worker-token.bin`; preferences are in `settings.json`. Both live in the app's data folder (`~/Library/Application Support/kindahired`,
  `~/.config/kindahired`). The worker runs Claude Code in `<data folder>/agent`, an empty folder:
  the app sets `JH_DATA_DIR` to its data folder, and the worker never loads the repo's `config.ts`
  or `.env` (`scripts/bundle.mjs` fails the build if it would).
- **Claude Code check:** looks for `claude` on `PATH`, then in `~/.claude/local`, `~/.local/bin`,
  `/opt/homebrew/bin` and `/usr/local/bin`; runs `claude -p "Reply with ok" --output-format json`
  once at start (and from **Check again**), without any `ANTHROPIC_API_KEY`; and sets
  `JH_CLAUDE_BIN` for the worker. If it's missing or signed out, the window and tray say so and
  link to https://claude.com/claude-code. The app never reads or stores Claude's credentials.
- **Tray:** status (online, working, offline, token refused, paused), Claude steps done today, Open
  dashboard, Pause worker, Settings…, Check for updates, Quit. Closing every window leaves it
  running. The dashboard window keeps its own persistent session, so the Cloudflare Access login is
  remembered; links to other sites open in the browser.
- **Open at login** (on by default, after setup): a login item on macOS, an
  `~/.config/autostart/kindahired.desktop` entry on Linux. While a Claude step runs, the app holds
  a `prevent-app-suspension` power blocker, and only then.
- **Updates:** electron-updater with the GitHub provider, on macOS and the AppImage. The `.deb`
  can't replace itself, so it shows a "new version" notice with a download link instead.

## Names in one place

`app.config.json` holds the app id (`com.kindavishal.kindahired`), the product name (`kindahired`),
the GitHub owner and repo that releases and updates come from, and the `.deb` maintainer. The
build config (`electron-builder.config.cjs`) and the app both read it, so a rename happens there.

## Run it in development

```sh
cd apps/desktop
npm install
npm start                                     # builds, then runs electron .
npx electron . --user-data-dir=/tmp/kh-dev    # a separate copy with its own settings
npm test                                      # settings, Claude detection, hub check
npm run typecheck
```

Updates and the login item only run in the installed app.

## Build

```sh
npm run dist:dir    # an unpacked app in release/ for this computer, quickest
npm run dist        # macOS: universal .dmg and .zip; Linux: AppImage and .deb
```

Without signing secrets the macOS app is signed ad hoc: it runs on the computer that built it, but
other Macs will refuse it, and auto-update needs a properly signed build. Linux builds need no
secrets. Build each platform on that platform (the release workflow does both).

**The icon is a placeholder** drawn by `scripts/make-icons.mjs` (a tick on a dark rounded square,
plus menu bar and tray versions). Before a public release, replace `build/icon.png` (1024×1024) and the
tray PNGs it writes to `assets/` with real artwork: commit those files (they're git-ignored now) and
take the script out of `npm run build`.

## Releasing

Push a tag like `desktop-v0.2.0`. `.github/workflows/desktop-release.yml` creates a draft release,
builds macOS (on `macos-latest`) and Linux (on `ubuntu-latest`), uploads the files and the
`latest-*.yml` update manifests, then publishes the release. The version comes from the tag.

- The workflow uploads to the repo it runs in, and the app looks for updates in the repo named in
  `app.config.json`. Keep them the same, and keep that repo's releases public (the updater reads
  them without a login).
- The updater takes the repo's **latest** release, so desktop releases should be the latest ones.
  If the repo also gets other releases, mark those as not latest.

### Secrets

Add these under the repo's Settings › Secrets and variables › Actions. All are optional: without
them the macOS build is unsigned and not notarized.

| Secret | What it is | Where to get it |
|---|---|---|
| `CSC_LINK` | The Developer ID Application certificate and its private key, as a base64 `.p12` | developer.apple.com › Certificates, IDs & Profiles › Certificates › + › Developer ID Application. Install it, export it from Keychain Access as a `.p12` with a password, then `base64 -i cert.p12 \| pbcopy`. |
| `CSC_KEY_PASSWORD` | That `.p12`'s password | The one you chose when exporting |
| `APPLE_API_KEY` | The App Store Connect API key, the whole `.p8` file's text | appstoreconnect.apple.com › Users and Access › Integrations › App Store Connect API › Team Keys › + (Developer access is enough). The `.p8` downloads once only. |
| `APPLE_API_KEY_ID` | That key's ID | The Key ID column on the same page |
| `APPLE_API_ISSUER` | The issuer ID | Shown above the keys list on the same page |

The workflow writes the `.p8` to a temporary file and passes its path as `APPLE_API_KEY`, which is
what electron-builder's notarizing expects. To sign and notarize locally, set the same variables
in your shell, with `APPLE_API_KEY` set to the `.p8` file's path.

## Installing it (for testers)

1. Install Claude Code from https://claude.com/claude-code, run `claude` once in a terminal, and
   sign in with your Claude account.
2. From the Releases page, download:
   - **macOS:** `kindahired-<version>.dmg`. Open it and drag the app to Applications.
   - **Linux:** the `.AppImage` (make it executable: `chmod +x kindahired-*.AppImage`, then run it;
     it updates itself), or the `.deb` (`sudo apt install ./kindahired-*.deb`; it tells you when a
     new version is out).
3. Open the app and sign in with your email code. The tick icon in the menu bar or tray shows the
   status.

On Linux the tray needs a desktop with tray support (GNOME needs the AppIndicator extension), and
the token is best kept with GNOME Keyring or KWallet installed.

## What hasn't been checked by hand

The settings window, hub check, Claude check and a full job round trip have been run against a
local fake hub and a fake `claude`. The tray menu, the dashboard window's Cloudflare Access login,
signing, notarizing, auto-update, the login item and the Linux builds still need a person to try
them.
