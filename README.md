# Job Hunting Tool

A personal job-search assistant that runs on your Mac.

- **Every relevant posting becomes a ready-to-act pack.** Sources: job-alert emails, LinkedIn saved jobs, or a link you send it. Each pack has an honest fit read, the exact apply link, a tailored resume PDF, a cover note, form answers, and 2–3 people to contact with drafted messages.
- **No conversation goes quiet without a decision.** Every reply you owe, follow-up due, unsent note and closing date becomes an action with a due time. Actions resolve on their own when things change.
- **You act, it prepares.** It never applies, sends a message or follows up for you. Gmail access is read-only.

Rules for everything it writes live in your `context/playbook.md` (start from [`context/playbook.example.md`](context/playbook.example.md)). The design is in [`docs/design.md`](docs/design.md).

## How a role reaches you

1. **A summary card first.** Each role you send the bot gets one message: what it is, whether it fits and why, location, pay and closing date, with **Build pack** and **Skip** buttons. New matches from your email arrive together as one list a few times a day; roles that don't fit stay off Telegram, though they're still on the dashboard and in the sheet.
2. **The pack only when you tap Build pack.** It arrives as three messages:
   - the resume PDF, with the apply link and **Applied** / **Drop** buttons;
   - the application: cover note and form answers, folded so they don't flood the chat;
   - the people to contact, each with a LinkedIn link, the connection note ready to copy, and **Note sent** / **DM sent** buttons.
3. **No blanks in the resume.** The resume never contains "[FILL IN]": anything uncertain is left out. If the cover note or form answers need something only you know, the bot lists the questions. Reply to that message with one answer per line, and it sends the completed text back.


## Setup (one time, about 20 minutes)

All commands run from this folder.

### 1. Configuration file

```bash
cp .env.example .env
```

Fill in `MY_EMAILS` (the addresses you send from, comma separated). No API key is needed in the default setup. Times are shown in this computer's time zone; set `JH_TIMEZONE` (for example `Europe/London`) to use another.

### Your profile

Two files describe you. They stay on this computer and out of git.

```bash
cp context/profile.example.json context/profile.json
cp context/playbook.example.md context/playbook.md
```

- **`context/profile.json`**: your name, headline, location, contact details and portfolio link go on every resume. `targets` lists the role families you're going for; the tool screens postings against them and builds its Gmail, X and LinkedIn searches from them. Add `keywords` (short phrases such as `"devrel"`) if the targets alone don't catch how roles are usually titled.
- **`context/playbook.md`**: the rules every step follows: where you can work, how you write, what to skip. Fill in the bracketed parts.

### AI setup (free: Gemini's free tier and your Claude plan)

The AI work is split by what each step needs:

- **Quick steps run on Gemini Flash-Lite** when `GEMINI_API_KEY` is set: email screening (10 emails per request) and pulling the details out of a posting's page. Each takes a second or two. The fit read stays on Claude Code, because it's the decision you act on. Gemini's free tier doesn't include Google Search, so when a role has no readable link, the web search runs through Claude Code. Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The free tier allows about 15 requests a minute and a few hundred a day; past that, these steps fall back to Claude Code. On the free tier Google may use what you send to improve its products.

- **Without a Gemini key, quick steps run through Claude Code** too. It works, but it's slower and counts toward your plan.
- **Fit reads, resumes, cover notes, people research and DMs run through Claude Code**, logged in to your Claude plan. It's the same quality as your Project chats, with no API credit.

To set it up:

1. Make sure Claude Code is logged in to your Claude account. Run `claude` once and check that it starts.
2. Optional but recommended: put a free Gemini key in `.env` as `GEMINI_API_KEY`.

Until a Gemini key is set, recent email is screened through Claude Code, and the 90-day backfill waits so it doesn't use up your plan. Each pack takes several Claude Code steps and counts toward your plan's usage limits. If you hit a limit, packs wait and the bot tells you.

### 2. Google: Gmail and Calendar (read-only) and your tracker sheet

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Enable the **Gmail API**, the **Google Sheets API** and the **Google Calendar API**.
3. Set up the **OAuth consent screen**: External, then add your own Gmail address as a test user.
4. Go to **Credentials**, create an **OAuth client ID** of type **Desktop app**, and put its ID and secret into `.env`.
5. Connect:

```bash
npm run jh -- auth:google
```

### 3. Import your tracker

Pulls the Roles, Outreach and Facts tabs, then reads your "Next step" notes to set the real status and due dates:

```bash
npm run jh -- import
```

### 4. Build your evidence bank from your portfolio

Reads the site in `portfolio` (in your profile) plus the facts from your tracker, and turns them into the list of true facts every resume line must trace back to:

```bash
npm run jh -- evidence:build
```

It lists facts where sources disagree, such as different dates for the same job. Until you settle them, resumes use the portfolio's version and flag the question.

### 5. Telegram

1. In Telegram, message **@BotFather**, send `/newbot`, and put the token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Link your chat:

```bash
npm run jh -- telegram:link
```

### 6. LinkedIn

A browser window opens. Log in yourself; the session stays in `data/browser-profile`.

```bash
npm run jh -- linkedin:login
```

### 7. Run it

Try it in the foreground first:

```bash
npm run daemon
```

To keep it running in the background, install it as a login item. The command prints the `launchctl` line that starts it:

```bash
npm run jh -- service:install
```

The service keeps the Mac awake while it's on power. If the Mac sleeps, overnight alerts wait until it wakes.

## Other inboxes (Outlook, other Gmail accounts)

The tool reads one Gmail account: the one you connected in step 2. Send your other inboxes there:

- **Outlook:** Settings → Mail → Rules → Add new rule → apply to all messages → **Redirect to** your connected Gmail. Use Redirect, not Forward: Redirect keeps the original sender, so the tool knows who wrote.
- **Another Gmail:** Settings → Forwarding and POP/IMAP → add your connected Gmail as a forwarding address. Gmail forwarding keeps the original sender.
- Add every address you send from to `MY_EMAILS` in `.env`.

Mail you send from those other inboxes stays there, so the tool can't see your replies. When you answer someone from another inbox (or on LinkedIn or WhatsApp), tap **Replied** on the reminder. That records your reply and starts the follow-up timer.

## Saving a job you come across

Every saved link goes through the same steps as an email alert: the posting is identified, the pack is built, and it arrives in Telegram.

- **On your phone:** share the link to your Telegram bot (Share → Telegram → your bot). Add a note in the same message if you like ("founder posted this on X"). The bot replies straight away with what it found. A few minutes later it sends the pack: fit read, apply link, resume PDF, cover note, form answers, and each person's messages with Sent buttons. The role is also added to your tracker sheet. LinkedIn job links are read through your own logged-in browser. X posts are read through the X API once it's set up (see X below), and the thread is watched for new replies. Until then, paste the post's text along with the link.
- **On the Mac:** drag the **Save job** button from the dashboard to your browser's bookmarks bar (works in Chrome and Dia). On any job page, click it, add an optional note, and save.
- **On LinkedIn:** just press LinkedIn's own Save. Saved jobs are picked up on the next LinkedIn sync, a few times a day.
- **In the terminal:** `npm run jh -- add <url> [note]`.

If you've already saved that role, you get the existing pack again instead of a duplicate.

## Target companies

The companies you most want to work at, watched through their own job board so a new role reaches you within a few hours of going live. Add them on the dashboard's **Companies** page (one per line), or in Telegram:

```text
/company Stripe
Factory
Packt | https://apply.workable.com/packtpublishing
```

Companies from the roles you track (ones you decided on, applied to, interviewed with or saved on LinkedIn) are added on their own and start from what's open now, so only roles posted afterwards are screened. A board guessed from a name that lists none of your roles there is held, paused, with **Check this board**: confirm it with **Right company** or paste the real careers link. A company you remove stays removed.

Boards on Greenhouse, Lever, Ashby, Workable, SmartRecruiters and Recruitee are found from the name alone, or from any careers or posting link after a `|`. Each board is read through its public job list every 3 hours (change it per company), and only new titles are screened against your targets. A company with no board found falls back to watching its careers page. When a new role is at a company where you already know someone, the card says so. `/companies` lists them in Telegram. From the terminal:

```bash
npm run jh -- companies:add "Stripe" "Packt | https://apply.workable.com/packtpublishing"
```

```bash
npm run jh -- companies
```

## People and warm closures

The **People** page lists everyone you've had a real exchange with about work, on email, LinkedIn or a call:

- **Close:** you've met, or written back and forth several times.
- **Warm:** you've each written at least once.

People who haven't answered, and machine or team inboxes, aren't counted.

- **When a role ends:** each person you talked to gets a short closing note to send, written for how it ended (a no, or you stepping back). It skips anyone you've already written to since.
- **After that:** a light stay-in-touch reminder, every 60 days for people you know well and every 120 for the rest. Change these on the Timers page. Anything from either side restarts the clock, and so does **In touch today**. **Stop reminders** turns them off for one person.
- **When their company posts a role:** you're asked to tell them before you apply.

## Who's hiring

For each role you're about to apply to or have applied to, the tool works out who's hiring. It checks LinkedIn's own "Meet the hiring team" on the job page, your email and LinkedIn threads, the post the role came from, and the company's job board, then runs one web search. The brief names the likely hiring manager and recruiter, with how sure it is and the evidence for each. It also covers the team, posts about the opening, people you already know there, related openings, and angles for your application. Applied roles go first, two every half hour. The first-touch reminder then names the person to write to, and the outreach drafts in a pack start from them. A brief is redone after a month, or straight away with **Research again** on the role's page.

```bash
npm run jh -- hiring 156
```

## Watching job boards and careers pages

Add any public page that lists openings, such as [jobs in the wild](https://jobsinthewild.tal.club/?sort=new), a company's careers page or a curated feed. The tool checks it every few hours. New postings that fit your targets arrive in Telegram as one list, the same way email alerts do, with **Build pack** on each. Postings that don't fit are noted and left out of your tracker.

- **Telegram:** `/watch https://jobsinthewild.tal.club/?sort=new` (add a name after the link if you like). `/sources` lists what's watched, with **Scan**, **Pause** and **Remove** buttons. If you send a plain link that turns out to be a board rather than a single posting, the bot offers **Watch this page**.
- **Dashboard:** the **Watched pages** tab at http://127.0.0.1:4321/sources lets you add a page and pick how often it's checked (2 to 24 hours), and shows each page's last scan and the roles found there. The **Watch page** bookmarklet on that tab adds whatever page you're on.
- **Terminal:**

```bash
npm run jh -- watch "https://jobsinthewild.tal.club/?sort=new" "Jobs in the wild" --every 4
```

```bash
npm run jh -- sources
```

How it works: each scan opens the page in a background browser and scrolls a few times, so feeds that load more as you scroll show their newer posts. If no new links have appeared since the last scan, nothing more happens. Otherwise only the new part of the page is screened, on the same quick model as email (Gemini, or Claude Code without a key). One scan adds at most 10 new matches, and any extra wait for the next scan. If a page fails 3 times in a row, the bot tells you once and checks it less often until it works again.

Tips: if a board has filters or a "newest" sort, set them first and watch that link. LinkedIn and X pages need a login, so they can't be watched this way. X has its own section below.

## X (paid per use, optional)

Roles posted on X reach you the same way as email alerts: one list in Telegram, with **Build pack** on each. The tool uses X's official API, so your account isn't at risk. It only reads: it never posts, likes, follows or sends messages.

It looks in four places, every 4 hours:

- **Your bookmarks.** Bookmark a hiring post on X and it's picked up on the next run.
- **Threads.** Send a link to an X post to the bot. It reads the post and every reply, files any roles, and checks the thread for new replies every 6 hours for 14 days. "Drop your openings" threads it comes across are watched the same way. The reply has a **Stop watching** button.
- **Accounts you watch.** Founders, hiring managers and team leads whose posts you want checked for roles, whether or not they say "hiring". Add them with `/xfollow @handle` in Telegram.
- **Searches.** Hiring posts that mention your target roles, built from `targets` (or `keywords`) in your profile. Roles in places the playbook rules out are dropped at screening.

Whoever posted a role is saved as a contact. Posts are screened on the quick model (Gemini, or Claude Code without a key), and a post is never screened or paid for twice.

**Cost.** X charges per post read: about $0.005 per post, and $0.001 for your own bookmarks. `X_MONTHLY_BUDGET_USD` (default $15) is a hard cap, spread across the month so a busy week can't use it all. When the month's cap is reached, X pauses until the 1st and the bot tells you once. `/x` in Telegram shows what's been spent, plus the accounts and threads being watched.

**Setup (about 10 minutes):**

1. At [console.x.com](https://console.x.com), create a developer account and an app, and add a small prepaid balance (around $10).
2. From the app's **Keys and tokens**, copy the **Bearer token** into `.env` as `X_BEARER_TOKEN`, or the **API Key** and **API Key Secret** as `X_API_KEY` and `X_API_SECRET`. Either is enough for threads, accounts and searches.
3. For bookmarks: in the app's **User authentication settings**, turn on OAuth 2.0 with read permissions, set the callback URL to `http://127.0.0.1:53683/callback`, copy the **Client ID** (and **Client Secret**, if it shows one) into `.env`, then connect your account:

```bash
npm run jh -- auth:x
```

Check it works without waiting 4 hours:

```bash
npm run jh -- x:scan
```

```bash
npm run jh -- x:status
```

## Firecrawl web search (free, optional)

When a role arrives without a usable link, the tool has to search the web for the real posting. With `FIRECRAWL_API_KEY` set, that's one Firecrawl search: the best results (the company's careers page or applicant tracking system first, job boards never) are then opened in the tool's own browser. It takes seconds instead of a few minutes of Claude Code research. The same search looks up a person's LinkedIn profile for the people-to-contact step.

The free plan gives 1,000 credits a month and can't be charged. A search costs 2 credits, so that's roughly 500 searches. The tool counts credits as it goes. When they run out it goes back to Claude Code until the month resets, so nothing stops. `npm run jh -- status` shows the month's use.

## Daily use

- **Telegram:** send any job link to add it; a pack comes back in a few minutes. Send `/today` for your list. Tap buttons to mark things done, sent or applied.
- **Dashboard:** http://127.0.0.1:4321 shows the pipeline, what needs you now, LinkedIn saved-but-not-applied, each role's full pack, and which sources lead to replies.
- **Terminal:**

```bash
npm run jh -- status
```

```bash
npm run jh -- today
```

```bash
npm run jh -- add "https://jobs.example.com/role" "seen on X, founder posted it"
```

## The lifecycle: every role always has a next step

Each role in play has exactly one next step with a due date, and the timers that set those dates are on the dashboard's **Timers** page:

- **Before applying:** decide, then apply. A role nobody decides on is skipped after 14 days.
- **After applying:** reach a person within a day, follow up after a week of quiet, follow up again on another channel a week later, then close warmly a week after that.
- **Interviews** (from Google Calendar): prepare the day before, send a thank-you after, rebook a cancelled one. Follow-ups wait while an interview is booked.
- **Anything from their side** (an email, a LinkedIn reply, an interview invite) restarts the steps. A taken-down posting brings the next follow-up forward.
- **Offers:** a step to respond.

If you drop a reminder without changing the role, the role shows under **No next step** on Today until you bring the reminder back or close it.

LinkedIn messages are read every 90 minutes. Only conversations with people you've already contacted, or whose latest line is about a job, are opened; personal chats are left alone. Run it now with:

```bash
npm run jh -- sync:linkedin-messages
```

Interviews are read from your primary Google Calendar every 30 minutes. Only events that match a role you track are kept.

```bash
npm run jh -- sync:calendar
```

## Your tracker sheet

The tool keeps your Google Sheet up to date, every 10 minutes and right after each pack:

- New roles and contacts are added as new rows at the bottom. Rows are never deleted or reordered.
- On rows you wrote, it only moves the tracking columns forward (status, dates, sent, reply) and fills empty cells. Your wording is kept, even when it means the same thing as the tool's ("Check if still open").
- If you edit any cell, that cell is yours from then on, and the tool won't change it again.
- Resume links point to the PDF on your Google Drive. The tool uploads into its own "Job Hunting Tool — resumes" folder and can only see files it created. This needs the Drive permission: run `npm run jh -- auth:google` once more to grant it.

Preview what the next sync would change:

```bash
npm run jh -- sheet:sync --dry
```

## What's not built yet

- The people-to-contact step still researches people through Claude Code, because it needs their recent posts for the message's opening line. Firecrawl only speeds up finding their profile links.
- X DMs and WhatsApp chats aren't synced. Mark those replies with the **They replied** button.
- Edits you make in the sheet aren't read back into the tool. Use the bot buttons or the dashboard to change a role's status.

## Tests

```bash
npm test
```

Tests run against the example profile and playbook, so they work on a fresh clone. They cover the sheet import (the real Roles tab test runs only when `data/import/roles.json` exists), the open-loop rules, the no-invention resume check, PDF rendering, Gmail filing and the full pack pipeline, with stand-in AI responses.
