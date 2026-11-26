import { readFileSync } from "node:fs";
import { sheets } from "@googleapis/sheets";
import { env } from "../config.ts";
import { upsertContact, upsertOutreach } from "../db/contacts.ts";
import { get, kvSet, run } from "../db/index.ts";
import { listOpportunities, normalise, upsertOpportunity, type OpportunityFields } from "../db/opportunities.ts";
import { googleClient } from "../sources/google-auth.ts";
import { recordRow } from "./mirror.ts";

export type Grid = string[][];
export interface SheetData {
  roles: Grid;
  outreach: Grid;
  facts: Grid;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "18 Nov 2026", "23 Nov 2026 (WhatsApp)", "5 Dec 2026", "2026-12-05" -> "2026-12-05". */
export function parseLooseDate(text: string | undefined | null, fallbackYear = new Date().getFullYear()): string | null {
  if (!text) return null;
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = text.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/i);
  if (!m) return null;
  const year = m[3] ? Number(m[3]) : fallbackYear;
  const month = MONTHS[m[2].toLowerCase()];
  return `${year}-${String(month).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
}

export function mapRoleStatus(s: string): string {
  const v = s.trim().toLowerCase();
  if (v.startsWith("applied")) return "applied";
  if (v.startsWith("ready")) return "ready";
  if (v.startsWith("dropped") || v.startsWith("skip")) return "dropped";
  if (v.includes("interview")) return "interviewing";
  if (v.includes("reject")) return "rejected";
  if (v.includes("offer")) return "offer";
  return "decide"; // "Ask before applying", "Check if still open", anything else
}

export function mapSentStatus(sent: string, reply: string): string {
  const v = sent.trim().toLowerCase();
  if (reply.trim()) return "replied";
  if (v === "skip") return "skipped";
  if (v.startsWith("note")) return "note_sent";
  if (v === "sent" || v.startsWith("dm sent") || v.startsWith("email sent")) return "dm_sent";
  return "drafted";
}

/** Turns a grid with a header row into objects keyed by a short name per column. */
/** Column index for each short name, matched on the header row. */
export function columnIndex(header: string[], columns: Record<string, RegExp>): Record<string, number> {
  const index: Record<string, number> = {};
  for (const [key, re] of Object.entries(columns)) {
    const i = header.findIndex((h, n) => re.test(h) && !Object.values(index).includes(n));
    if (i >= 0) index[key] = i;
  }
  return index;
}

/** Turns a grid with a header row into objects keyed by a short name per column, with the sheet row number. */
function rows(grid: Grid, columns: Record<string, RegExp>): (Record<string, string> & { __row: number })[] {
  const [header, ...body] = grid;
  if (!header) return [];
  const index = columnIndex(header, columns);
  return body
    .map((r, n) => ({ r, row: n + 2 }))
    .filter(({ r }) => r.some((c) => c && c.trim()))
    .map(({ r, row }) => ({
      ...Object.fromEntries(Object.entries(index).map(([k, i]) => [k, (r[i] ?? "").trim()])),
      __row: row,
    }) as Record<string, string> & { __row: number });
}

export const ROLE_COLS = {
  company: /^company/i, role: /^role/i, status: /^status/i, who: /who can apply/i, gate: /hard gate/i,
  fit: /^fit/i, pay: /^pay/i, apply: /apply link/i, closes: /^closes/i, cover: /cover note/i,
  form: /form answers/i, next: /next step/i, applied: /date applied/i, dm: /date dm sent/i,
  reply: /^reply/i, resume: /tailored resume/i,
};
export const OUTREACH_COLS = {
  company: /^company/i, person: /^person/i, title: /their role/i, where: /^where/i, degree: /^degree/i,
  linkedin: /^linkedin/i, why: /why them/i, warm: /warm dm/i, hookFrom: /ice-breaker|hook/i,
  note: /connection note/i, full: /full dm/i, time: /best time/i, sent: /^sent/i, reply: /^reply/i,
};

export function importSheetData(data: SheetData) {
  const stats = { roles: 0, outreach: 0, facts: 0, unlinkedOutreach: [] as string[] };

  for (const r of rows(data.roles, ROLE_COLS)) {
    if (!r.company || !r.role) continue;
    const resume = r.resume?.match(/https?:\/\/\S+/)?.[0] ?? null;
    const fields: OpportunityFields = {
      status: mapRoleStatus(r.status ?? ""),
      source: "sheet_import",
      who_can_apply: r.who || null,
      hard_gate: r.gate || null,
      fit_read: r.fit || null,
      pay: r.pay || null,
      apply_url: r.apply?.match(/https?:\/\/\S+/)?.[0] ?? (r.apply || null),
      closes_on: parseLooseDate(r.closes) ?? parseLooseDate(r.gate?.match(/closes [^.]*/i)?.[0]),
      cover_note: r.cover || null,
      form_answers: r.form || null,
      next_step: [r.next, r.reply && `Reply: ${r.reply}`].filter(Boolean).join("\n") || null,
      date_applied: parseLooseDate(r.applied),
      resume_url: resume,
      // An imported row already has everything a pack has.
      pack_status: r.cover || resume ? "ready" : "none",
      gate_result: /^none/i.test(r.gate ?? "") ? "pass" : r.gate ? "ask" : null,
    };
    const opp = upsertOpportunity(r.company, r.role, fields);
    recordRow("Roles", r.__row, "role", opp.id, r);
    stats.roles++;
  }

  // Oldest first, so the same company always links to the same role across imports.
  const opps = listOpportunities().sort((a, b) => a.id - b.id);
  const findOpp = (company: string) => {
    const key = normalise(company);
    if (!key) return undefined;
    return opps.find((o) => normalise(o.company) === key) ?? opps.find((o) => {
      const k = normalise(o.company);
      return k.startsWith(key) || key.startsWith(k);
    });
  };

  for (const r of rows(data.outreach, OUTREACH_COLS)) {
    if (!r.person) continue;
    const email = r.person.match(/[\w.+-]+@[\w.-]+/)?.[0];
    const contact = upsertContact({
      name: r.person.replace(/\(.*?\)/g, "").trim(),
      title: r.title || null,
      location: r.where || null,
      degree: r.degree || null,
      linkedin_url: r.linkedin?.includes("linkedin.com") ? r.linkedin : null,
      email: email ?? null,
      notes: r.linkedin && !r.linkedin.includes("linkedin.com") ? r.linkedin : null,
    });
    // If this person is already linked to one of this company's roles, keep that link.
    const linked = get<{ opportunity_id: number }>(
      `SELECT r.opportunity_id FROM outreach r JOIN opportunities o ON o.id = r.opportunity_id
       WHERE r.contact_id = $c AND o.dedupe_key LIKE $k ORDER BY r.id LIMIT 1`,
      { c: contact.id, k: (normalise(r.company) || "~") + "%" },
    );
    const opp = linked ? opps.find((o) => o.id === linked.opportunity_id) : findOpp(r.company);
    if (!opp) stats.unlinkedOutreach.push(`${r.person} (${r.company})`);
    const status = mapSentStatus(r.sent ?? "", r.reply ?? "");
    const outreach = upsertOutreach({
      opportunity_id: opp?.id ?? null,
      contact_id: contact.id,
      why_them: r.why || null,
      hook: r.warm || null,
      hook_source: r.hookFrom || null,
      connection_note: r.warm && !/^\(|^see /i.test(r.warm) ? r.warm : r.note || null,
      alt_note: r.note && !/^\(/.test(r.note) && r.note !== r.warm ? r.note : null,
      full_dm: r.full || null,
      send_time: r.time || null,
      status,
      reply: r.reply || null,
      replied_at: parseLooseDate(r.reply),
    });
    recordRow("Outreach", r.__row, "outreach", outreach.id, r);
    stats.outreach++;
  }

  kvSet("sheet.mapped", "1");

  const [, ...facts] = data.facts;
  for (const [claim, source, note] of facts) {
    if (!claim?.trim()) continue;
    const conflict = /\bsays\b|check which|wins|worth updating/i.test(note ?? "") ? 1 : 0;
    run(
      `INSERT INTO evidence (claim, source, note, conflict) VALUES ($claim, $source, $note, $conflict)
       ON CONFLICT(claim) DO UPDATE SET source = excluded.source, note = excluded.note, conflict = excluded.conflict`,
      { claim: claim.trim(), source: source?.trim() || "Facts I used", note: note?.trim() || null, conflict },
    );
    stats.facts++;
  }
  return stats;
}

/** Reads the three tabs through the Sheets API. */
export async function fetchSheet(sheetId = env.trackerSheetId): Promise<SheetData> {
  const api = sheets({ version: "v4", auth: googleClient() });
  const res = await api.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges: ["Roles!A1:Z1000", "Outreach!A1:Z1000", "'Facts I used'!A1:Z1000"],
  });
  const [roles, outreach, facts] = (res.data.valueRanges ?? []).map((v) => (v.values ?? []) as Grid);
  return { roles: roles ?? [], outreach: outreach ?? [], facts: facts ?? [] };
}

/** Reads exported values JSON files ({ "values": [[...]] }) when Google isn't connected yet. */
export function readSheetFiles(files: { roles?: string; outreach?: string; facts?: string }): SheetData {
  const load = (p?: string): Grid => (p ? JSON.parse(readFileSync(p, "utf8")).values ?? [] : []);
  return { roles: load(files.roles), outreach: load(files.outreach), facts: load(files.facts) };
}
