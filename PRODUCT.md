# Product

## What it is

A personal job-search assistant that runs on one Mac. It turns every relevant posting into a
ready-to-act pack (fit read, apply link, tailored resume PDF, cover note, form answers, people to
contact with drafted messages) and turns every loose end into an action with a due date, so no
conversation goes quiet without a decision.

The tool prepares; the person acts. It never applies, sends a message or follows up by itself.

## Who uses it

One person running an active job search: several new roles a day and dozens of open actions at
any time, across local and remote roles. It was built first for community, DevRel and
developer-programs roles; the profile and playbook adapt it to other role families.

Assumption (inferred from the README and code, not from an interview): the user is technical
enough to run a daemon from the terminal, reads most updates on Telegram on the phone, and opens
the dashboard on the Mac for deeper review, batch triage and copying drafts.

## Surfaces

| Surface | Mode | Job |
|---|---|---|
| Telegram bot | Operate | Pings, digest, one-tap buttons on the phone |
| Local dashboard (`http://127.0.0.1:4321`) | Operate | Triage today's actions, review a role's full pack, copy drafts, manage watched pages |
| Google Sheet mirror | Read | A familiar tracker view; the database is the source of truth |

## Dashboard jobs, in priority order

1. **Clear today's list.** See what needs a move, grouped by kind, and mark it done, snoozed or
   dropped without losing scroll position.
2. **Work one role.** Open the pack: read the fit, copy the cover note and form answers, open the
   application, contact the right people, mark progress.
3. **Find a role.** Filter by stage, search by company or title.
4. **Feed the pipeline.** Paste a link, or watch a job board.
5. **Check what's working.** Pipeline counts and which sources lead to replies.

## Principles

- **Honest over flattering.** Fit verdicts and gaps are shown plainly.
- **One next move per item.** Every row says what to do and offers the button that does it.
- **Local and private.** No external requests from the dashboard: no web fonts, no CDNs, no
  analytics.
- **Fast enough to forget.** Server-rendered HTML, small inline script, works without JavaScript.

## Out of scope

Multi-user accounts, hosting, and any automation that sends or applies on the user's behalf.
