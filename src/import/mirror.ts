import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { drive } from "@googleapis/drive";
import { sheets } from "@googleapis/sheets";
import { env } from "../config.ts";
import { all, get, kvGet, kvSet, logEvent, run } from "../db/index.ts";
import type { Opportunity } from "../db/opportunities.ts";
import { googleClient, googleConnected, hasScope } from "../sources/google-auth.ts";
import { columnIndex, mapRoleStatus, mapSentStatus, OUTREACH_COLS, parseLooseDate, ROLE_COLS, type Grid } from "./sheet.ts";

/**
 * Keeps the Google Sheet tracker in step with the tool. New roles and contacts are added as new
 * rows. A cell is only changed if it still holds what the tool last saw there; if I edited it,
 * my version stays. Older rows are never deleted or reordered.
 */

type Cells = Record<string, string>;

export function recordRow(tab: string, row: number, entity: "role" | "outreach", entityId: number, cells: Cells, origin?: "import" | "tool") {
  const clean = Object.fromEntries(Object.entries(cells).filter(([k]) => k !== "__row").map(([k, v]) => [k, String(v ?? "").trim()]));
  run(
    `INSERT INTO sheet_rows (tab, row, entity, entity_id, cells, origin) VALUES ($tab, $row, $entity, $id, $cells, $origin)
     ON CONFLICT(entity, entity_id) DO UPDATE SET tab = excluded.tab, row = excluded.row, cells = excluded.cells,
       origin = coalesce($originSet, sheet_rows.origin)`,
    { tab, row, entity, id: entityId, cells: JSON.stringify(clean), origin: origin ?? "import", originSet: origin ?? null },
  );
}

// On my own rows, the tool only moves the tracking columns forward. Everything else I wrote
// stays as I wrote it, unless the cell is empty.
const TRACKING_KEYS = new Set(["status", "applied", "dm", "reply", "sent"]);

export function sheetRowFor(entity: "role" | "outreach", id: number): number | undefined {
  return get<{ row: number }>("SELECT row FROM sheet_rows WHERE entity = $e AND entity_id = $id", { e: entity, id })?.row;
}

const STATUS_LABEL: Record<string, string> = {
  found: "New", decide: "Ask before applying", ready: "Ready to apply", applied: "Applied", interviewing: "Interviewing",
  offer: "Offer", rejected: "Rejected", dropped: "Dropped", skipped: "Skipped",
};
const SENT_LABEL: Record<string, string> = {
  drafted: "Not sent", note_sent: "Note sent", dm_sent: "DM sent", replied: "DM sent", conversation: "DM sent", skipped: "Skip",
};
const day = (iso: string | null) =>
  iso ? new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

// ---------- Resume PDFs on Google Drive, so the sheet's resume link opens on any device ----------

async function resumeLink(o: Opportunity): Promise<string> {
  if (!o.resume_path || !existsSync(o.resume_path)) return o.resume_url ?? "";
  if (o.resume_url?.includes("drive.google.com")) return o.resume_url;
  if (!hasScope("https://www.googleapis.com/auth/drive.file")) return o.resume_url ?? "";
  const api = drive({ version: "v3", auth: googleClient() });
  let folder = kvGet("drive.resumeFolder");
  if (!folder) {
    const f = await api.files.create({
      requestBody: { name: "kindahired — resumes", mimeType: "application/vnd.google-apps.folder" },
      fields: "id",
    });
    folder = f.data.id!;
    kvSet("drive.resumeFolder", folder);
  }
  const file = await api.files.create({
    requestBody: { name: path.basename(o.resume_path), parents: [folder] },
    media: { mimeType: "application/pdf", body: createReadStream(o.resume_path) },
    fields: "id, webViewLink",
  });
  const link = file.data.webViewLink ?? `https://drive.google.com/file/d/${file.data.id}/view`;
  run("UPDATE opportunities SET resume_url = $u WHERE id = $id", { u: link, id: o.id });
  return link;
}

// ---------- What each row should say ----------

async function roleCells(o: Opportunity, dry = false): Promise<Cells> {
  const people = all<{ name: string; title: string | null }>(
    `SELECT c.name, c.title FROM outreach r JOIN contacts c ON c.id = r.contact_id WHERE r.opportunity_id = $id ORDER BY r.id LIMIT 2`,
    { id: o.id },
  );
  const sentAt = get<{ at: string | null }>("SELECT max(sent_at) at FROM outreach WHERE opportunity_id = $id", { id: o.id })?.at ?? null;
  const reply = get<{ reply: string | null }>("SELECT reply FROM outreach WHERE opportunity_id = $id AND reply IS NOT NULL ORDER BY replied_at DESC", { id: o.id })?.reply ?? "";
  return {
    company: o.company,
    role: o.role,
    status: STATUS_LABEL[o.status] ?? o.status,
    who: o.who_can_apply ?? "",
    gate: o.status === "skipped" ? `Skipped: ${o.skip_reason ?? ""}` : o.hard_gate ?? "",
    fit: o.fit_read ?? "",
    pay: o.pay ?? "",
    apply: o.apply_url ?? o.source_url ?? "",
    closes: o.closes_on ? day(o.closes_on) : "",
    cover: o.cover_note ?? "",
    form: o.form_answers ?? "",
    main: people[0] ? `${people[0].name}${people[0].title ? `, ${people[0].title}` : ""}` : "",
    second: people[1] ? `${people[1].name}${people[1].title ? `, ${people[1].title}` : ""}` : "",
    next: o.next_step ?? "",
    applied: day(o.date_applied),
    dm: day(sentAt),
    reply,
    // A Drive problem only costs the link; the rest of the row still syncs.
    resume: dry ? (o.resume_url ?? "") : await resumeLink(o).catch((err) => {
      logEvent("drive.upload_failed", o.id, String(err).slice(0, 300));
      return o.resume_url ?? "";
    }),
  };
}

function outreachCells(r: Record<string, string | null>): Cells {
  return {
    company: r.company ?? "",
    person: r.name ?? "",
    title: r.title ?? "",
    where: r.location ?? "",
    degree: r.degree ?? "",
    linkedin: r.linkedin_url ?? "",
    why: r.why_them ?? "",
    warm: r.connection_note ?? "",
    hookFrom: r.hook_source ?? "",
    note: r.alt_note ?? "",
    full: r.full_dm ?? "",
    time: r.send_time ?? "",
    sent: SENT_LABEL[r.status ?? ""] ?? r.status ?? "",
    reply: r.reply ?? "",
  };
}

// Columns the sheet has that the import maps to these keys. "main"/"second" are role-only.
// A function, not a constant: sheet.ts and this file import each other.
const roleSyncCols = () => ({ ...ROLE_COLS, main: /main contact/i, second: /second contact/i });

/**
 * Decides which cells of one existing row to change.
 * - A cell I edited since the tool last saw it is mine: left alone, and becomes the new baseline.
 * - A cell is never blanked.
 * - On rows I wrote, only empty cells are filled and the tracking columns (status, dates, sent,
 *   reply) move forward. On rows the tool added, any column can be refreshed.
 */
/** Two ways of writing the same thing, e.g. "Check if still open" and "Ask before applying". */
function sameMeaning(key: string, cell: string, value: string): boolean {
  if (key === "status") return mapRoleStatus(cell) === mapRoleStatus(value);
  if (key === "applied" || key === "dm") return !!cell && parseLooseDate(cell) === parseLooseDate(value);
  if (key === "sent") return !!cell && mapSentStatus(cell, "") === mapSentStatus(value, "");
  return false;
}

export function planRow(index: Record<string, number>, current: string[], seen: Cells, want: Cells, toolRow: boolean) {
  const writes: { col: number; value: string }[] = [];
  const next: Cells = { ...seen };
  for (const [key, col] of Object.entries(index)) {
    const value = want[key];
    if (value === undefined) continue;
    const cell = (current[col] ?? "").trim();
    if (key in seen && cell !== seen[key]) { next[key] = cell; continue; }
    if (!value.trim() || cell === value.trim() || sameMeaning(key, cell, value)) { next[key] = cell; continue; }
    if (!toolRow && cell && !TRACKING_KEYS.has(key)) { next[key] = cell; continue; }
    writes.push({ col, value });
    next[key] = value.trim();
  }
  return { writes, next };
}

const colLetter = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

async function syncTab(
  tab: string,
  entity: "role" | "outreach",
  columns: Record<string, RegExp>,
  items: { id: number; cells: Cells }[],
  dry = false,
) {
  const api = sheets({ version: "v4", auth: googleClient() });
  const res = await api.spreadsheets.values.get({ spreadsheetId: env.trackerSheetId, range: `'${tab}'!A1:Z2000` });
  const grid = (res.data.values ?? []) as Grid;
  const header = grid[0] ?? [];
  const index = columnIndex(header, columns);
  const updates: { range: string; values: string[][] }[] = [];
  const appends: { id: number; cells: Cells }[] = [];
  let changed = 0;

  for (const item of items) {
    const mapped = get<{ row: number; cells: string; origin: string }>("SELECT row, cells, origin FROM sheet_rows WHERE entity = $e AND entity_id = $id", { e: entity, id: item.id });
    if (!mapped) { appends.push(item); continue; }
    const plan = planRow(index, grid[mapped.row - 1] ?? [], JSON.parse(mapped.cells), item.cells, mapped.origin === "tool");
    for (const w of plan.writes) updates.push({ range: `'${tab}'!${colLetter(w.col)}${mapped.row}`, values: [[w.value]] });
    changed += plan.writes.length;
    if (!dry) recordRow(tab, mapped.row, entity, item.id, plan.next, mapped.origin as "import" | "tool");
  }

  if (dry) {
    return {
      updated: changed, added: appends.length,
      preview: [
        ...updates.map((u) => `${u.range}: ${u.values[0][0].slice(0, 70).replace(/\n/g, " ")}`),
        ...appends.map((a) => `new row: ${Object.values(a.cells).slice(0, 2).join(" — ")}`),
      ],
    };
  }
  if (updates.length) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: env.trackerSheetId,
      requestBody: { valueInputOption: "RAW", data: updates },
    });
  }

  for (const item of appends) {
    const width = Math.max(header.length, ...Object.values(index).map((i) => i + 1));
    const row = Array.from({ length: width }, () => "");
    for (const [key, col] of Object.entries(index)) row[col] = item.cells[key] ?? "";
    const r = await api.spreadsheets.values.append({
      spreadsheetId: env.trackerSheetId,
      range: `'${tab}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });
    const rowNo = Number(r.data.updates?.updatedRange?.match(/(\d+):?[A-Z]*\d*$/)?.[1] ?? 0);
    if (rowNo) recordRow(tab, rowNo, entity, item.id, item.cells, "tool");
  }
  return { updated: changed, added: appends.length, preview: [] as string[] };
}

/** Pushes new and changed roles and contacts to the tracker sheet. Safe to run as often as needed. */
export async function syncSheet(opts: { dry?: boolean } = {}) {
  if (!googleConnected() || !env.trackerSheetId) return null;
  // Rows already in the sheet must be matched first (by importing it), or they'd be added twice.
  if (!kvGet("sheet.mapped")) return { skipped: "Run `npm run jh -- import` once so the tool knows which rows are already in the sheet." };
  // Roles worth seeing in the tracker: anything with a pack or a decision, plus links I sent that
  // were skipped (so I can see why). Low-match alerts that were screened out stay out.
  const opps = all<Opportunity>(
    `SELECT * FROM opportunities
     WHERE (pack_status = 'ready' AND status != 'skipped')
        OR (status = 'skipped' AND source IN ('manual','linkedin_saved'))
        OR status IN ('applied','interviewing','offer','rejected')
        OR id IN (SELECT entity_id FROM sheet_rows WHERE entity = 'role')
     ORDER BY id`,
  );
  const roleItems = [];
  for (const o of opps) roleItems.push({ id: o.id, cells: await roleCells(o, opts.dry) });
  const roles = await syncTab("Roles", "role", roleSyncCols(), roleItems, opts.dry);

  const outreachRows = all<Record<string, string | null> & { id: number }>(
    `SELECT r.*, c.name, c.title, c.location, c.degree, c.linkedin_url, o.company
     FROM outreach r JOIN contacts c ON c.id = r.contact_id LEFT JOIN opportunities o ON o.id = r.opportunity_id
     WHERE r.opportunity_id IS NULL OR r.opportunity_id IN (${opps.map((o) => o.id).join(",") || "0"})
     ORDER BY r.id`,
  );
  const outreach = await syncTab("Outreach", "outreach", OUTREACH_COLS, outreachRows.map((r) => ({ id: r.id, cells: outreachCells(r) })), opts.dry);
  const result = { roles, outreach };
  if (opts.dry) return result;
  if (roles.added || roles.updated || outreach.added || outreach.updated) logEvent("sheet.sync", null, result);
  kvSet("sheet.lastSync", new Date().toISOString());
  return result;
}
