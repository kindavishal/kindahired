# Hub and desktop app: plan

Status: being built. Version 4, 2026-11-26. The build contracts are in [hub-build.md](hub-build.md).

## Decisions

- **A cloud hub** on an Oracle Cloud Always Free ARM VM. It runs one engine per person, so Gmail,
  scans, timers, digests and pings keep going while laptops sleep.
- **One shared Telegram bot.** It's owned by a router on the hub, which looks like the Telegram
  Bot API to each engine.
- **Claude stays on each person's computer.** A desktop worker runs their own Claude Code, signed
  in to their own subscription, as genmotion does. In hub mode, packs and research wait for it;
  people with an API key can run Claude on the hub instead.
- **About 12 trusted testers**, behind Cloudflare Access (email-code login, free up to 50 people).
  Everyone is told that you, as the operator, can read every person's data on the hub.
- **Google:** one shared OAuth client, consent screen "In production" and unverified (up to 100
  users), so there's no CASA.
- **Quick steps:** Gemini free tier by default, or Haiku 5.5 when the person has API credit.
- **Desktop app:** macOS, signed and notarized with the existing Apple account, with auto-update.
  Linux as AppImage and `.deb`. No Windows.
- **LinkedIn:** later. It needs the person's own browser, so it will move to the worker after the
  first beta.

## Shape

```
Hub VM (Oracle Always Free: 4 ARM cores, 24 GB)
  cloudflared ── gateway :8080 ── Access JWT → engine@<person> :44xx (today's daemon, own SQLite)
                     ├── /telegram/webhook → router :8090 (bot token, per-person queues)
                     └── /worker/* (bearer token) → that person's engine
Each person's computer
  desktop app: tray + window on their dashboard + worker running their own Claude Code
```

## What it costs

**Each tester:** the app and hub are free. Claude is whatever plan they already have: Pro (about
$20) for packs only with screening on Gemini, or Max 5x (about $100) to run everything on Claude.
Their usage would cost roughly $250 a month at API prices. Quick steps are free on Gemini, or cents
a month on Haiku. X is optional and capped by them.

**You:** $0 for Oracle Always Free, Cloudflare Tunnel and Access, the unverified Google client,
Linux packaging, and GitHub Releases. Apple is already paid. A domain on Cloudflare is about
$10–15 a year.

Check current Claude plan prices and limits, and Oracle and Google's free-tier rules, before
quoting them.

## Build order

1. Quick-step routing (Haiku, `--model haiku`).
2. Telegram router and the relay transport in `telegram.ts`.
3. Worker queue on the engine, plus the worker client.
4. Gateway, people registry, `hub` CLI and systemd units.
5. Desktop app: Electron tray and window running the worker, signed macOS build, Linux builds.
6. Google OAuth through the hub (a public redirect in place of the loopback).
7. Setup pages on the hub: profile, playbook, connections.
8. Deployment on the VM, then a beta with 2–3 people, then everyone.
9. Later: LinkedIn on the worker.

## Risks

- Google's rules for unverified apps could tighten. The fallback is each person bringing their own client.
- Oracle Always Free capacity and reclaim policy. Keep nightly SQLite backups off the VM.
- A breach of the hub exposes everyone's data and Gmail tokens. Keep engines as separate Linux
  users, keep tokens encrypted at rest, and give each person export and delete buttons.
- Anthropic's terms: Claude Code always runs on each person's own computer and login. Read the
  current consumer terms before sharing.
