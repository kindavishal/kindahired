# Launch kit

Planning draft for if and when this is open-sourced as a self-hosted tool. Today it is a personal, local-only project with no public repo, pricing or signup.

Placeholders in `[brackets]` need a real value before anything goes out. Nothing here is a real metric, user count or quote.

---

## 1. Positioning

**One line:** A self-hosted job-search assistant that turns every posting into a ready-to-act pack and every loose end into a due action. You do the applying and sending.

**Who it's for**

- People running an active search with real volume (several new roles a day, dozens of open threads), who are losing track of follow-ups.
- Technical enough to run a Node daemon on a Mac and paste keys into `.env`.
- Want their inbox, resume facts and outreach drafts to stay on their own machine.
- Built first for community, DevRel and developer-programs roles; the playbook file makes it adaptable to other roles.

**Three differentiators**

1. **It prepares, you act.** Each role becomes a pack: fit read, the real apply link, a tailored resume PDF, a cover note, form answers, and 2 or 3 people to contact with drafted notes. It never applies, sends a message or follows up on its own. Gmail access is read-only.
2. **Honest fit reads, no invented facts.** It says what fits, what's a stretch and when not to apply. Every resume line must trace back to an evidence bank built from your own portfolio and notes. If a fact is uncertain it is left out, and questions only you can answer are listed for you.
3. **Nothing goes quiet.** An open-loop engine turns every reply you owe, follow-up due, unsent note and closing date into an action with a due time. Actions resolve on their own when things change. A thread only closes when the other side ends it or you close it with a reason.

**What it is not**

- Not an auto-apply bot or a mass-outreach tool. It sends nothing for you.
- Not a hosted service. No accounts, no cloud backend, no multi-user mode.
- Not a job board. It reads the sources you already use (job-alert email, LinkedIn saves, X, boards you choose to watch).
- Not a resume "optimizer" that inflates claims to beat filters.

---

## 2. README / landing hero copy

**Variant A (outcome)**
- Headline: Every job posting, turned into a pack you can act on.
- Subhead: Fit read, apply link, tailored resume, cover note and people to contact, prepared on your own Mac. You stay the one who applies and sends.
- CTA: Set it up in [~20 minutes]

**Variant B (the loose-ends problem)**
- Headline: No job conversation goes quiet without a decision.
- Subhead: Every reply you owe, follow-up due and closing date becomes an action on your phone. Self-hosted, read-only on Gmail, never sends for you.
- CTA: Read the setup guide

**Variant C (trust)**
- Headline: A job-search assistant that won't make things up.
- Subhead: Honest fit reads and resumes built only from facts you've written down. Runs locally, drafts everything, sends nothing.
- CTA: See a sample pack

**CRO checklist for the README or landing page**

- [ ] Above the fold: headline, one-sentence subhead, the "prepares, you act" promise, and one CTA. No feature grid before the reader knows what it does.
- [ ] Demo GIF directly under the hero (15 to 20s): a link shared to Telegram, the summary card, Build pack, the three pack messages. Under 5 MB, with a still poster frame.
- [ ] Setup time stated plainly with prerequisites: macOS, Node 24+, a Google Cloud OAuth client, a Telegram bot token, Claude Code logged in. Say which steps are optional (Gemini, X, Firecrawl).
- [ ] "What leaves your machine" section near the top, not buried (see section 7 for the content).
- [ ] One screenshot per core surface: Today list, a Role pack, Telegram pack messages.
- [ ] Costs table: what is free, what is paid per use (X API), what counts against an AI plan's limits.
- [ ] "What it will never do" list: apply, send DMs, send email, follow up, write to Gmail.
- [ ] FAQ: Does it apply for me? (No.) Will LinkedIn ban me? (It uses your own logged-in browser for saved jobs only; state the risk honestly.) Linux or Windows? ([answer]) Do I need a paid AI plan? Can I change the rules it writes by? (Yes, `context/playbook.md`.) What if the AI is wrong about fit?
- [ ] Known limits section, copied from "What's not built yet".
- [ ] Second CTA at the bottom pointing to the setup steps.
- [ ] License badge and a link to issues for questions.

---

## 3. Product Hunt / directory listing

**Taglines (under 60 characters)**

1. Job-search packs on your Mac. You apply, it prepares. (54)
2. Self-hosted job search that never lets a thread go quiet (56)
3. Honest fit reads and tailored resumes, run locally (50)

**Description (under 260 characters)**

> A self-hosted job-search assistant. It turns postings from your email, LinkedIn saves and watched boards into packs: fit read, resume PDF, cover note, form answers, people to contact. Every loose end becomes a due action. It never sends for you.

(About 250 characters; recount after edits.)

**Maker's first comment**

> Hi, I'm [name]. I built this for my own job search in [community / DevRel] roles after I lost track of who I owed a reply and which roles closed before I applied.
>
> What it does: every relevant posting becomes a pack with an honest fit read, the real apply link, a tailored resume PDF, a cover note, form answers and a few people worth contacting, with drafted notes. Every loose end becomes an action with a due time, sent to Telegram.
>
> What it won't do: apply, send a message or follow up for you. Gmail is read-only. Resume lines can only use facts you've written down, so it leaves things out rather than invent them.
>
> It's self-hosted on a Mac and open source under [license]. Setup takes about [20] minutes. Some parts use outside services (Gemini free tier, Claude Code, optionally the X API and Firecrawl); the README lists exactly what leaves your machine.
>
> I'd like feedback on the setup steps and on whether the fit reads match your own judgement.

**Topics:** Productivity, Open Source, Developer Tools, Artificial Intelligence, Career (or Hiring / Job Search where offered)

**Gallery shot list** (use seed data, never a real inbox; 1270x760 for Product Hunt)

1. **Today, grouped actions.** The Today page with groups (replies owed, follow-ups due, unsent notes, closing soon), each row with its one next move and Done / Snooze / Drop.
2. **Role pack page.** One role open: fit verdict with fits / stretch / gates, apply link, resume PDF link, cover note and form answers with copy buttons, people to contact.
3. **Roles filter.** The Roles list filtered by stage, with a company search applied.
4. **Watched pages.** The Watched pages tab: a few boards, check interval, last scan, roles found.
5. **Telegram pack messages.** Phone screenshot: summary card with Build pack / Skip, then the resume PDF message with Applied / Drop, then people to contact with Note sent / DM sent.
6. (Optional) **Telegram digest.** One list of new email matches, each with Build pack.

---

## 4. Announcements

Rules for all of these: say it's yours, link once, no "launching today, please upvote", answer every reply.

### X thread

1. I built a job-search assistant that runs on my own Mac. It prepares everything for a role and never sends anything for me. Now open source: [repo URL]
2. The problem: 5 to 10 new roles a day and 60+ open threads. Things went quiet not because I decided, but because I forgot.
3. Each role becomes a pack: an honest fit read, the real apply link, a tailored resume PDF, a cover note, form answers, and 2 or 3 people to contact with drafted notes.
4. Every loose end becomes an action with a due time: a reply I owe, a follow-up, an unsent note, a closing date. They resolve on their own when things change.
5. It won't invent facts. Resume lines must trace back to my own portfolio and notes. If it's unsure, it leaves the line out and asks me.
6. It reads Gmail (read-only), LinkedIn saved jobs through my own browser, X bookmarks and job boards I tell it to watch. Everything lands in Telegram and a local dashboard.
7. Self-hosted, [license]. The README lists exactly what leaves the machine and what costs money. Feedback on setup is very welcome: [repo URL]

### LinkedIn post (first person, builder voice)

> For the last [few months] I've been job hunting for community and DevRel roles. The hard part wasn't finding roles. It was keeping track.
>
> At any point I had dozens of open threads: a recruiter I owed a reply, a follow-up due Thursday, a role closing on the 5th, a note I drafted and never sent. Some of them went quiet just because I lost them.
>
> So I built a small tool that runs on my Mac. For every role I care about it prepares a pack: an honest read on whether I fit, the real apply link, a resume tailored from facts I've written down, a cover note, and a few people worth reaching out to, with a draft for each.
>
> Every loose end turns into an action with a due date on my phone.
>
> Two rules I kept from day one. It never applies or sends anything for me. And it never makes up a fact about me. If it isn't sure, it leaves it out.
>
> I've open-sourced it for anyone who wants to run it themselves: [repo URL]
>
> If you're searching right now, I'd like to hear what you'd want it to do differently.

(About 190 words.)

### Reddit: r/selfhosted

Check the sub's current rules on self-promotion and flair first; post on a weekday, use the project or "Release" flair if required.

- **Title:** I made a self-hosted job-search assistant (Node, runs on a Mac, read-only Gmail, sends nothing on your behalf)
- **Body:**
  > Disclosure: this is my project, free and [license].
  >
  > It's a Node/TypeScript daemon with SQLite, a local dashboard on 127.0.0.1 and a Telegram bot. It reads job-alert email (Gmail, read-only scope), LinkedIn saved jobs through a browser profile you log in to yourself, optional X bookmarks via the official API, and any job board you ask it to watch. For each role it builds a pack (fit read, resume PDF, cover note, form answers, contacts with drafts) and tracks every loose end as a due action.
  >
  > What stays local: the database, your tracker, and the dashboard (no web fonts, CDNs or analytics).
  > What doesn't: fit reads and drafts go through Claude Code on your own plan; Gemini free tier is optional for quick steps; X API and Firecrawl are optional. Details in the README.
  >
  > Limits: macOS only for now (launchd service), needs Node 24, setup is about [20] minutes of OAuth and tokens. No Docker image yet [or: Docker image at ...].
  >
  > Happy to answer questions about the architecture.

### Reddit: r/cscareerquestions

Many career subs ban tool promotion outright. Read the rules and the pinned threads; if promotion isn't allowed, share only in an allowed weekly thread, or skip it. Lead with the method, not the tool.

- **Title:** What helped me stop losing track of 60+ job threads: treat every loose end as a task with a due date
- **Body:**
  > During my search I kept losing threads: replies I owed, follow-ups I meant to send, roles that closed before I applied. What fixed it was one rule: no conversation closes until someone decides it does. Every thread gets a next action and a due date, and a role is only "closed" when they reject, I withdraw, or it's filled.
  >
  > Other things that helped: an honest fit read before tailoring anything (including "don't apply"), finding the real apply link on the company site instead of the job board copy, and only putting facts on a resume that I'd written down somewhere first.
  >
  > Disclosure: I built a small open-source tool that does this bookkeeping for me. It drafts but never applies or sends. Link in a comment if the mods allow it.

### Hacker News

- **Title:** Show HN: A self-hosted job-search assistant that prepares everything and sends nothing
- **First comment:**
  > I built this during my own job search. It's a Node/TypeScript daemon on a Mac with SQLite, a server-rendered dashboard and a Telegram bot.
  >
  > Two engines. The first turns a posting (job-alert email, LinkedIn save, X post, watched board, or a pasted link) into a pack: resolve the real posting on the company's site, check hard gates (region, timezone, language, years), write a fit read, then a resume PDF, cover note, form answers and a few contacts with drafted notes. The second is an open-loop engine: replies owed, follow-ups, unsent notes and closing dates become actions with due times, and a thread only closes with a reason.
  >
  > Design choices: plain code for bookkeeping (dedupe, timers, status), AI only for judgement. Resume lines must trace to an evidence bank, checked in tests. Gmail scope is read-only and nothing is ever sent.
  >
  > Outside services: Claude Code for fit reads and drafts, optionally Gemini free tier for screening, optionally the X API and Firecrawl. I'd like feedback on the no-invention check and the loop rules.

### Communities to share in

Read each community's promotion rules and use the designated channel (usually #show-and-tell, #tools or #jobs-adjacent).

- **Led by Community** (community/DevRel job board and community; the tool already sources from it, so a "how I track roles from here" post fits).
- **CMX** community.
- **DevRel Collective** Slack.
- **Community Club** and **Rosieland** (community-manager communities).
- **Indie Hackers** (builder story angle).
- r/selfhosted, r/opensource, r/devrel, r/jobs (check rules), Lobsters (needs an invite; tag `show`).
- Local developer groups in [city] and alumni groups, where a personal "here's what I built while searching" post is welcome.

---

## 5. Store listing

Not applicable (no app store build).

---

## 6. Demo video (Remotion outline, 30 fps, about 55 s / 1650 frames)

Record real screens against seed data only. Composition: 1920x1080, 30 fps, `durationInFrames: 1650`. Phone footage in a device frame, dashboard in a plain browser frame. No voiceover needed; captions carry it. Quiet music bed, ducked under any UI sounds.

| # | Frames | Time | Scene | On-screen text | Footage to record |
|---|---|---|---|---|---|
| 1 | 0 to 120 | 0 to 4 s | Hook: a cluttered inbox of job alerts and a long tracker sheet scroll | "60 open threads. Which ones went quiet?" | Seed Gmail-style list (mocked), seed sheet scroll |
| 2 | 120 to 300 | 4 to 10 s | Share a job link to the Telegram bot | "Send it a link." | Phone: Share sheet, Telegram bot, link sent |
| 3 | 300 to 480 | 10 to 16 s | Summary card arrives | "An honest fit read first." | Phone: summary card with fit, location, pay, closing date, Build pack / Skip |
| 4 | 480 to 750 | 16 to 25 s | Tap Build pack, three messages arrive | "Resume, cover note, form answers, people to contact." | Phone: resume PDF message, folded application message, contacts with drafts |
| 5 | 750 to 960 | 25 to 32 s | Role pack page on the dashboard | "Every line traces to facts you wrote down." | Dashboard Role pack: fit section, copy buttons, resume link |
| 6 | 960 to 1200 | 32 to 40 s | Today page, grouped actions, mark one Done | "Every loose end gets a due date." | Dashboard Today: groups, Done / Snooze, list keeps its place |
| 7 | 1200 to 1350 | 40 to 45 s | Watched pages tab, add a board | "Watch the boards you already check." | Dashboard Watched pages: add URL, interval, last scan |
| 8 | 1350 to 1500 | 45 to 50 s | Promise card | "It prepares. You apply and send." | Static type over a dimmed Today page |
| 9 | 1500 to 1650 | 50 to 55 s | End card | "Self-hosted. Open source. [repo URL]" | Project name, license, repo URL |

Notes: keep each caption on screen for at least 2 s; transitions are simple cuts or 8 to 10 frame crossfades; blur or replace any real names, emails and companies; export a 15 to 20 s cut (scenes 2, 3, 4, 6) for the README GIF.

---

## 7. Pre-launch checklist

**Secrets and personal data out of the repo**

- [ ] Start the public repo from a fresh history (or audit history) so no past commit carries secrets.
- [ ] `.env` stays ignored; ship only `.env.example` with empty values and comments.
- [ ] `data/` fully ignored: `kindahired.db*` and backup copies, `google-token.json`, `browser-profile/`, `linkedin-session.json`, `agent/`, `import/`, generated PDFs.
- [ ] Any X OAuth tokens and Telegram chat IDs live only in `data/` or `.env`.
- [ ] `context/profile.json` ignored; ship a `context/profile.example.json`.
- [ ] Replace the personal playbook with a template `context/playbook.example.md` (keep the rules, drop the personal location, portfolio and sources).
- [ ] Remove hardcoded personal values from code, tests and docs: the portfolio domain in `src/cli.ts` and `test/pipeline.test.ts`, the local resume folder path, references to a real tracker's rows.
- [ ] Tests use only fictional fixtures (the sheet import test currently uses a real Roles tab).
- [ ] Run a secret scanner (for example gitleaks or trufflehog) on the final tree and history.

**Sample data for screenshots and the demo**

- [ ] A `npm run jh -- seed` (or similar) command that fills a fresh `data/` with fictional companies, roles, contacts, actions and a sample evidence bank.
- [ ] Seed covers every gallery screen: grouped Today actions, a full Role pack, several stages for the Roles filter, two or three Watched pages.
- [ ] A test Telegram bot and chat for phone recordings.

**License and repo basics**

- [ ] Choose a license ([MIT / Apache-2.0 / AGPL-3.0]) and add `LICENSE`; set `"private": false` and `"license"` in `package.json` when publishing.
- [ ] Check dependency licenses are compatible.
- [ ] `CONTRIBUTING.md` and issue templates kept short; state scope (single user, never sends) so feature requests for auto-apply can be closed with a link.

**Setup**

- [ ] A setup script (`npm run setup` or `scripts/setup.sh`) that checks Node 24+, copies `.env.example`, checks Claude Code login, optionally checks the Gemini key, and prints the next step for each missing piece.
- [ ] Time a clean setup on a fresh macOS user account and put the real number in the README.
- [ ] State platform support honestly (macOS launchd today) and what would be needed for Linux.
- [ ] Google OAuth: document that users create their own Cloud project and test-user consent screen; no shared client ID is shipped.

**Privacy note: what leaves the machine** (put this in the README)

- [ ] **Stays local:** the SQLite database, dashboard (127.0.0.1 only, no fonts, CDNs or analytics), resume PDFs, and browser profile and sessions.
- [ ] **Gemini free tier (optional):** batches of email text and posting pages for screening and extraction. Say clearly that on the free tier Google may use this data to improve its products.
- [ ] **Claude Code (your own plan):** posting details, your evidence bank and playbook for fit reads, resumes, cover notes, people research and drafts. Usage counts toward your plan's limits.
- [ ] **X API (optional, paid per read):** read-only requests for bookmarks, threads, watched accounts and searches; capped by `X_MONTHLY_BUDGET_USD`.
- [ ] **Firecrawl (optional, free plan):** search queries for a role's real posting and for contacts' profile links.
- [ ] **Google APIs:** Gmail read-only, Sheets for your tracker mirror, Drive limited to files the tool created.
- [ ] **Telegram:** pack messages, drafts and resume PDFs pass through Telegram's servers to your bot chat.
- [ ] **LinkedIn:** saved jobs are read through your own logged-in browser; note the terms-of-service risk plainly.

**Launch day**

- [ ] README hero, GIF, screenshots and FAQ in place; links checked.
- [ ] A tagged release ([v0.1.0]) with short release notes.
- [ ] Posts scheduled across different days, not all at once; time blocked to answer replies.
