import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { PATHS } from "../config.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per company + role. The centre of everything.
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  -- found | decide | ready | applied | interviewing | offer | rejected | dropped | skipped
  status TEXT NOT NULL DEFAULT 'found',
  source TEXT,                 -- gmail | linkedin_saved | telegram | cli | sheet_import | ...
  source_url TEXT,
  apply_url TEXT,
  who_can_apply TEXT,
  hard_gate TEXT,
  gate_result TEXT,            -- pass | ask | skip
  skip_reason TEXT,
  fit_read TEXT,
  fit_verdict TEXT,            -- apply | stretch | skip
  pay TEXT,
  closes_on TEXT,              -- ISO date
  cover_note TEXT,
  form_answers TEXT,
  company_brief TEXT,
  jd_text TEXT,
  next_step TEXT,
  date_applied TEXT,           -- ISO date
  resume_path TEXT,
  resume_url TEXT,
  linkedin_job_id TEXT UNIQUE,
  saved_on_linkedin INTEGER NOT NULL DEFAULT 0,
  -- none | queued | building | ready | failed
  pack_status TEXT NOT NULL DEFAULT 'none',
  pack_error TEXT,
  pack_ready_at TEXT,
  user_locked TEXT NOT NULL DEFAULT '[]', -- fields I edited by hand; automation never overwrites them
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,
  location TEXT,
  degree TEXT,
  linkedin_url TEXT UNIQUE,
  email TEXT UNIQUE,
  x_handle TEXT UNIQUE,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS outreach (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  why_them TEXT,
  hook TEXT,
  hook_source TEXT,
  connection_note TEXT,
  alt_note TEXT,               -- a second connection-note option
  full_dm TEXT,
  send_time TEXT,
  -- drafted | note_sent | dm_sent | replied | skipped
  status TEXT NOT NULL DEFAULT 'drafted',
  reply TEXT,
  sent_at TEXT,
  replied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (opportunity_id, contact_id)
);

-- A conversation on any channel.
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,       -- email | linkedin | x | whatsapp
  external_id TEXT NOT NULL,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id),
  subject TEXT,
  kind TEXT,                   -- conversation | application_update | job_alert | other
  last_message_at TEXT,
  last_from TEXT,              -- me | them
  last_snippet TEXT,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed
  closed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, external_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL UNIQUE,
  from_me INTEGER NOT NULL,
  sender TEXT,
  sent_at TEXT NOT NULL,
  body TEXT
);

-- Every open loop becomes an action with a due time. The loop engine owns rows with a rule_key.
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  rule_key TEXT UNIQUE,        -- stable key from the loop engine, null for manual actions
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
  outreach_id INTEGER REFERENCES outreach(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- apply | reply | follow_up | send_note | send_dm | decide | deadline | custom
  title TEXT NOT NULL,
  detail TEXT,
  due_at TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', -- open | done | dropped
  snoozed_until TEXT,
  notified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at TEXT
);

-- Facts about me. Generated content may only use these.
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  claim TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  note TEXT,
  conflict INTEGER NOT NULL DEFAULT 0
);

-- Raw page text from the portfolio, kept so the evidence bank can be rebuilt.
CREATE TABLE IF NOT EXISTS profile_sources (
  url TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Raw triggers before they become opportunities.
CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  raw TEXT,
  status TEXT NOT NULL DEFAULT 'new', -- new | processed | ignored | failed
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  ref TEXT,
  detail TEXT
);

-- Pages I asked the tool to watch (job boards, careers pages, curated feeds). Each is scanned
-- on its own timer; postings already seen are kept in inbox_items as source 'watch:<id>'.
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  interval_hours REAL NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'active', -- active | paused
  added_via TEXT,              -- web | telegram | cli
  seen_links TEXT NOT NULL DEFAULT '[]', -- links on the page at the last scan, to skip unchanged pages
  last_scanned_at TEXT,
  last_result TEXT,            -- JSON: what the last scan found
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);

-- Target companies, watched through their own job board (or a careers page when there's none).
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  board_type TEXT,             -- greenhouse | lever | ashby | workable | smartrecruiters | recruitee
  board_slug TEXT,
  careers_url TEXT,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  interval_hours REAL NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'active', -- active | paused
  added_via TEXT,
  seen_ids TEXT NOT NULL DEFAULT '[]',
  open_count INTEGER,
  last_scanned_at TEXT,
  last_result TEXT,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Calendar events matched to a role (interviews, calls). Events that match no role aren't kept.
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | tentative | cancelled
  link TEXT,                   -- the event in Google Calendar
  join_url TEXT,               -- video call link
  attendees TEXT,              -- JSON [{email, name}] of the other people
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- X threads being watched for new replies (ones I sent, and hiring posts worth following).
CREATE TABLE IF NOT EXISTS x_threads (
  conversation_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  label TEXT,
  added_via TEXT,              -- telegram | auto | cli
  watch_until TEXT NOT NULL,
  last_seen_id TEXT,           -- newest reply already read
  last_checked_at TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | stopped | ended
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Which tracker-sheet row holds which role or contact, and what the tool last saw or wrote in
-- each cell. A cell that no longer matches was edited by me, so the tool leaves it alone.
CREATE TABLE IF NOT EXISTS sheet_rows (
  tab TEXT NOT NULL,
  row INTEGER NOT NULL,
  entity TEXT NOT NULL,        -- role | outreach
  entity_id INTEGER NOT NULL,
  cells TEXT NOT NULL,         -- JSON {column key: value}
  origin TEXT NOT NULL DEFAULT 'import', -- import: my row; tool: a row the tool added
  PRIMARY KEY (tab, row),
  UNIQUE (entity, entity_id)
);
`;

let instance: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (!instance) {
    instance = new DatabaseSync(process.env.JH_DB ?? PATHS.db);
    instance.exec(SCHEMA);
    migrate(instance);
  }
  return instance;
}

/** For tests: an isolated in-memory database. */
export function useMemoryDb(): DatabaseSync {
  instance = new DatabaseSync(":memory:");
  instance.exec(SCHEMA.replace("PRAGMA journal_mode = WAL;", ""));
  migrate(instance);
  return instance;
}

// Columns added after the first version. Adding one that exists is a no-op.
const ADDED_COLUMNS = [
  "ALTER TABLE opportunities ADD COLUMN form_questions TEXT",
  "ALTER TABLE opportunities ADD COLUMN visa TEXT",
  "ALTER TABLE opportunities ADD COLUMN card_message_id INTEGER",
  "ALTER TABLE opportunities ADD COLUMN check_notes TEXT",
  // When the posting's links were last re-checked, and what they said: open | closed | unknown.
  "ALTER TABLE opportunities ADD COLUMN posting_checked_at TEXT",
  "ALTER TABLE opportunities ADD COLUMN posting_state TEXT",
  // A target company's board guessed from its name and not confirmed: watched only once I say it's right.
  "ALTER TABLE companies ADD COLUMN needs_check INTEGER NOT NULL DEFAULT 0",
  // Who's hiring for the role (JSON, see src/pipeline/hiring-brief.ts) and when it was researched.
  "ALTER TABLE opportunities ADD COLUMN hiring_brief TEXT",
  "ALTER TABLE opportunities ADD COLUMN hiring_brief_at TEXT",
  // Whether to keep reminding me to stay in touch: 1 yes, 0 never, null decided by warmth.
  "ALTER TABLE contacts ADD COLUMN stay_in_touch INTEGER",
  // When a LinkedIn connection note was accepted (the conversation appeared in my inbox).
  "ALTER TABLE outreach ADD COLUMN accepted_at TEXT",
];
function migrate(d: DatabaseSync) {
  for (const sql of ADDED_COLUMNS) {
    try { d.exec(sql); } catch { /* already there */ }
  }
}

type Params = Record<string, SQLInputValue>;

// Shared parameter objects often carry extra keys a given statement doesn't use; that's fine.
function prepare(sql: string) {
  const stmt = db().prepare(sql);
  stmt.setAllowUnknownNamedParameters(true);
  return stmt;
}

export function all<T>(sql: string, params: Params = {}): T[] {
  return prepare(sql).all(params) as T[];
}
export function get<T>(sql: string, params: Params = {}): T | undefined {
  return prepare(sql).get(params) as T | undefined;
}
export function run(sql: string, params: Params = {}) {
  return prepare(sql).run(params);
}

export function kvGet(key: string): string | undefined {
  return get<{ value: string }>("SELECT value FROM kv WHERE key = $key", { key })?.value;
}
export function kvSet(key: string, value: string) {
  run("INSERT INTO kv (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value", { key, value });
}

export function logEvent(kind: string, ref: string | number | null, detail?: unknown) {
  run("INSERT INTO events (kind, ref, detail) VALUES ($kind, $ref, $detail)", {
    kind,
    ref: ref === null ? null : String(ref),
    detail: detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail),
  });
}

export function nowIso() {
  return new Date().toISOString();
}
