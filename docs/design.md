# Job Hunting Tool: design

A personal system that turns every job opportunity into a ready-to-act pack and makes sure
no conversation goes quiet without a decision. Rules for all generated content live in
[`context/playbook.md`](../context/playbook.md).

## Principles

1. **The tool prepares, I act.** It never applies, sends or follows up by itself.
2. **Code for bookkeeping, AI for judgement.** Syncing, dedupe, status, timers and counts are
   plain code, so they're the same every time. Fit reads, resumes and drafts use the AI.
3. **No invented facts.** Generated content can only use the evidence bank built from
   the portfolio site and my notes. Every resume line must trace back to an entry.
4. **Nothing closes silently.** A thread closes only when the other side ends it or I close
   it with a reason.

## Two engines

### Engine 1: opportunity to pack

Triggers:
- A job alert or recruiter email lands in Gmail.
- A LinkedIn saved job shows up in the sync.
- I click "Save" in the browser extension (Chrome or Dia).
- A new Led by Community posting matches my filters.
- A founder or recruiter conversation starts on X or LinkedIn.

Steps:
1. **Extract and dedupe.** Company, role, source link. Merge with an existing opportunity if it
   matches.
2. **Resolve the real posting.** Find the role on the company's own careers page and read it:
   location rules, visa, pay, form questions.
3. **Hard gates.** Region locks, timezone (8 AM to 11 PM IST), language, years, coding depth.
   Skipped roles are kept with the reason, never deleted.
4. **Fit read.** What fits, what's a stretch, should I apply. Honest, never inflated.
5. **Pack.** Tailored resume (PDF), form answers with `[FILL IN]` gaps, 2 or 3 people to contact
   with a hook from a recent post, a connection note and DM for each, and a suggested send time.
6. **Notify.** A ping with the fit verdict and a link to the pack.

Volume is under 10 a day, so every role that passes the hard gates gets a full pack.

### Engine 2: open loops

Every thread (email, LinkedIn, X, WhatsApp) has one status: who owes the next move.

| Status | Rule | Action |
|---|---|---|
| I owe a reply | They wrote last and asked something | Alert at 12h, then 24h, with a draft reply |
| They owe a reply | I wrote last | Suggest a follow-up on day 5 to 7, with a draft |
| Applied, silent | No response 10 to 14 days | Suggest a person to reach out to, or close |
| Pack ready, not acted on | Pack older than 48h | Remind, or ask whether to drop it |
| Closed | Rejection, offer handled, or I closed it | Archive with the reason |

On first run, a **backfill** scans the last 90 days of email and LinkedIn DMs and lists every
dropped thread.

## Notifications

**Telegram bot** for pings and the daily digest:
- Instant on my phone, free, quick to build.
- Inline buttons act right from the message: Open pack, Snooze, Mark applied, Mark sent, Close.
- Scales to other users later: each person starts the bot with their own account.

Two kinds of message:
- **8 AM IST digest:** new packs, replies I owe, follow-ups due, saved jobs not applied.
- **Instant ping, urgent only:** a reply from a founder or recruiter, or a strong match just landed.

The web dashboard is for deeper review and editing.

## Dashboard

- Funnel: found, saved, applied, replied, interviewing, offer or rejected.
- Today: replies I owe, follow-ups due, packs waiting.
- Saved but never applied, oldest first, with a check that the posting is still open.
- Pack view: fit read, resume, form answers, outreach drafts, with buttons to mark each done.
- Source breakdown: which channels lead to replies and interviews.

## Architecture

Everything runs on my Mac. LinkedIn only works through my own logged-in browser, so the Mac has
to be on anyway, and keeping everything local removes hosting, cloud credentials and cost.

```
Mac (one background service, kept awake on power)
  Gmail API (read-only) ── every 10 min ──┐
  LinkedIn browser (my login) ── 4x/day ──┤
  Telegram links / dashboard form ────────┤
                                          ▼
                     SQLite: opportunities, contacts, outreach, threads, actions, evidence
                                          │
              AI steps: screen → research posting → fit read → resume → cover note → people + DMs
                                          │
                     Open-loop engine (plain code) → actions with due times
                                          │
                 Telegram bot (packs, pings, 8 AM digest, buttons) + local dashboard
```

Hosting it later (for phone access to the dashboard, or for other users) means moving the
SQLite tables to Postgres. LinkedIn would still need a logged-in browser per person.

## Data model (first cut)

- `opportunities`: company, role, links, source, status, hard-gate result, fit read, timestamps
- `contacts` and `contact_identities`: one person, many handles (email, LinkedIn, X, phone)
- `threads` and `messages`: a conversation on any channel, linked to an opportunity and contacts
- `loops`: current status, who owes the next move, due date, snooze
- `packs`: resume PDF, form answers, outreach drafts, version history
- `outreach`: per contact, the hook, drafts, suggested send time, sent status
- `evidence`: facts from the portfolio site and my notes, each with a source
- `events`: an audit log of everything the system did

## Build order

1. Foundation: project setup, schema, Gmail sync, open-loop engine, 90-day backfill, Telegram digest.
2. Evidence bank from the portfolio site, then fit reads and packs (resume PDF, form answers).
3. Local worker: LinkedIn saved jobs and DMs sync, then people research and outreach drafts.
4. Sourcing: Led by Community, careers-page resolution, alert email parsing.
5. Dashboard, browser extension, X and WhatsApp.

## What the current Google Sheet tells us

Tracker: "Job applications tracker: Led by Community roles (Nov 2026)", three tabs.

- **Roles** (28 rows): company, role, status, who can apply, hard gate, fit read, pay, exact
  apply link, closing date, cover note, form answers, main and second contact, next step,
  date applied, date DM sent, reply, tailored resume (a claude.ai artifact link).
- **Outreach** (26 rows): person, role, location, connection degree, LinkedIn, why them, warm
  DM, where the hook came from, connection note, full DM, best time to send (IST), sent, reply.
- **Facts I used**: each claim, its source, and notes. This is already an evidence bank,
  including conflicts between sources (for example, two different dates for the same job).

The pack format already works. What breaks is everything after the pack:

- **Packs pile up.** Most roles sit at "Ready to apply", and most outreach rows say "Not sent".
  Nothing reminds me or asks me to drop them.
- **Dates are missing.** Rows marked "Applied" often have no date applied, so follow-up timers
  can't start.
- **Replies hide in free text.** Replies and next steps are written into "Next step" as prose
  with dates inside ("Replied 17 Nov…", "Not cleared Technical Round 1 (24 Nov)…"). Nothing can
  sort or alert on them.
- **Drafts live outside the sheet.** Some are "drafted in chat on 16 Nov" and only exist in a
  chat.
- **Deadlines aren't tracked.** Closing dates appear in prose (Kong closes 5 Dec), not as a field.

The data model keeps every column, adds real fields for these, and turns "Next step" into a
structured action with a due date.

## Decisions so far

- Resumes stay one per role and are exported to PDF. Existing artifact resumes are kept as links.
- The database becomes the source of truth. The sheet is imported once. Writing updates back to it
  as a mirror is not built yet.
- "Facts I used" becomes the seed of the evidence bank, and conflicts between sources are
  flagged for me to settle.

- Resume PDFs use one clean layout: serif headings, sans body, one column, A4.
- Notifications go to a Telegram bot. Each pack arrives as a message with the apply link, the resume
  PDF, the cover note and per-person drafts with buttons. Messages are silent from 11 PM to 7:30 AM.
- Everything runs locally on the Mac (see Architecture).
- No API credit. Email screening runs on Gemini's free tier (or Claude Code without a key). Fit reads, resumes, outreach and web research run through Claude Code
  on my Claude plan. The Anthropic API path is still there (`JH_AI=api`) if I add credit later.
