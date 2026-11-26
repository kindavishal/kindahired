# Dashboard design system

The visual system for the local dashboard (`src/web/ui.ts` holds every token, component and the
enhancement script; `src/web/server.ts` renders pages; `src/web/insights.ts` computes the numbers
on What is working, Progress and the hints on Home). Architecture and engine design live in
[docs/design.md](docs/design.md).

**Mode:** Operate. The tool disappears into the task. Ambition shows as precision, density and
restraint, not decoration.

**World:** shadcn/ui (new-york, neutral), with patterns borrowed from IBM Carbon (filter tiles,
status shown by shape and colour, expandable rows, single-hue bars) and Ant Design (a greeting that
names the first move, tabs per kind of work, a split Later button with preset dates, confirm before
remove, a timeline for what is coming up). One visual language; the borrowed parts are restyled to it.

## Rules that hold everywhere

- Every value lives in a token in `ui.ts`. Markup uses classes; inline styles are only for
  data-driven sizes (a bar's width or height, a marker's position).
- Local and private: no web fonts, CDNs or analytics. The platform sans stands in for Geist.
- Every page works without JavaScript. The script adds in-place actions, Undo, row selection,
  shortcuts and the ⌘K dialog.
- Nothing scrolls sideways. Tab bars wrap; tables reflow.

## Typography

Platform sans (`ui-sans-serif, -apple-system, system-ui`); monospace only for copy-ready drafts.
Numbers use `tabular-nums`.

| Token | Size / line | Use |
|---|---|---|
| `--t-xs` | 12 / 16 | Badges, chips, chart labels, notes |
| `--t-sm` | 13 / 20 | Meta lines, secondary text |
| `--t-base` | 14 / 20 | Body, buttons, row titles (500) |
| `--t-md` | 15 / 22 | Card titles (600), lede |
| `--t-lg` | 17 / 24 | Section headings |
| `--t-xl` | 24 / 30 | Page heading |
| `--t-stat` | 28 / 34 | Tile numbers |

## Colour

Neutrals plus semantic tones. Colour carries state, never decoration. Light and dark follow
`prefers-color-scheme`; every token has both values.

| Token | Light | Use |
|---|---|---|
| `--bg` | `#fafafa` | App chrome, sidebar, row hover |
| `--surface` / `--surface-2` | `#fff` / `#f5f5f5` | Content, muted fills |
| `--ink` / `--ink-2` / `--ink-3` | `#0a0a0a` / `#525252` / `#6b6b6b` | Text levels (all ≥4.5:1 on their surfaces) |
| `--line` / `--line-strong` | `#e5e5e5` / `#d4d4d4` | Dividers, control borders |
| `--accent` | `#171717` | Primary button, selected tile |
| `--info` | `#1d4ed8` | Ready to apply |
| `--danger` | `#c10007` | Pending, errors, remove |
| `--warn` | `#92400e` | Due today, closing soon |
| `--ok` | `#15803d` | Interviews, offers |
| `--chart-*` | strong / mid / soft / track / band | Single-hue charts |

## Space, shape, depth

- 4px scale: `--s1`…`--s12` (4 8 12 16 20 24 32 40 48).
- Radius: 4 (checkbox, menu items), 6 (buttons, chips), 8 (menus), 10 (tables), 12 (cards, tiles).
- Depth: borders first. Shadows only for the inset page (`--shadow-sm`), menus (`--shadow-md`) and
  floating bars and dialogs (`--shadow-lg`).

## Layout

- Sidebar (240px) with Home, What is working, Progress, Roles, People, Companies, then Settings.
  Content sits in an inset panel, centred, max 1440px.
- Home answers one question: what do I do now. One ordered queue, ranked by `rankTasks`:
  interviews, then people waiting on you, then roles that close soon or are individual roles,
  then the rest by how long they have waited (two weeks at most; past a month a task drops back
  as likely stale). The first task is a large card with the reason it is first; the next four are
  compact rows. Clearing one moves the next up. "When you are done" links to everything else
  (more tasks, roles closing, no reply, this week) instead of showing it.
- Every task's main button does the task (`src/web/actions.ts`): Apply opens the application
  (or the pack when there is no link); a LinkedIn note copies the draft and opens the profile; an
  email note opens a prefilled email; replies and follow-ups open the Gmail thread or LinkedIn
  conversation; an interview offers Join the call near its start. Tasks close on their own when
  the sync sees the result (a confirmation email marks the role applied, a sent email or LinkedIn
  DM marks the note sent, a sent reply clears the reply). Opening a task sets it aside under
  "Waiting to confirm" for 48 hours; "I already did this" is only a fallback in the ⋯ menu.
  A LinkedIn connection note is the exception: opening it counts as sent (LinkedIn shows nothing
  until they accept). The LinkedIn inbox sync then records `accepted_at` when the conversation
  appears; People, the role page and the follow-up say "Sent, not accepted yet" or "Accepted".
- Interviews are P0 (`src/web/interviews.ts`). Any interview in the next 14 days shows as a card
  above Home's queue (emphasised in the accent colour from 3 days out): role, IST time and
  countdown, who you are meeting, the last message, and Open interview prep / Join the call.
  Each interview has a prep page (`/interviews/:id`): a checklist built from the invite and the
  hiring notes, every email and LinkedIn message about the role, the role and fit, the people,
  your cover note and resume, and other rounds. `/interviews` lists upcoming and earlier ones.
- All tasks (`/tasks`): four filter tiles, **Up next** with one card stack per type of work (Done
  or Later slides the top card off; Skip sends it to the back), the full list in sync with the
  stacks, and the time-sensitive cards (a right column from 1440px).
- Search (⌘K, the top-bar button, or `/search` without JavaScript; `src/web/search.ts`) covers
  everything: roles, target companies, people, open tasks, watched pages and the dashboard's own
  pages. A pasted link becomes its next step: a posting → make a pack; a job board → add the
  company as a target; a careers page → watch it; an X or LinkedIn post → add the roles in it;
  a link already tracked → open it instead of adding it twice. Words also offer "Watch “…” as a
  target company". Arrow keys move, Enter runs the highlighted result.
- People: four tiles (close, warm, due for a note, no reply yet), the notes due this week, then a
  searchable directory (last in touch, next reminder, In touch today, a menu for the rest).
- Companies: four tiles, a "Need your help" list (confirm a guessed board or paste a careers link,
  first 6 shown), the watched companies with roles found and last check, and Add companies beside.
- Below 900px the sidebar becomes a menu in the top bar.

## Voice

Indian English, short sentences, simple words, and say what is waiting: "3 conversations are
waiting for your reply", "25 messages are yet to be sent", "Pending for 8 days", "Remind me:
Tomorrow, After 3 days, Next Monday". Insights always show their counts ("4 of 12") and say when
the sample is small.

## Motion

160–220ms, `cubic-bezier(.2,.8,.2,1)`. A finished row fades and collapses; counts update in place.
`prefers-reduced-motion` turns transitions off.

## Anti-slop rules

- No gradients, glass, glow or decorative shadows; no eyebrow labels or section numbers.
- No emoji or Unicode glyphs as icons: authored stroke SVG only.
- No card inside a card, no coloured side stripes.
- Every number states a fact; every row offers the button that does its next move.
