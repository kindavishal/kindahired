import { all, get, run } from "./index.ts";

export interface Contact {
  id: number;
  name: string;
  title: string | null;
  location: string | null;
  degree: string | null;
  linkedin_url: string | null;
  email: string | null;
  x_handle: string | null;
  phone: string | null;
  notes: string | null;
}

export interface Outreach {
  id: number;
  opportunity_id: number | null;
  contact_id: number;
  why_them: string | null;
  hook: string | null;
  hook_source: string | null;
  connection_note: string | null;
  alt_note: string | null;
  full_dm: string | null;
  send_time: string | null;
  status: string;
  reply: string | null;
  sent_at: string | null;
  replied_at: string | null;
  accepted_at?: string | null;
  created_at: string;
}

export function normaliseLinkedIn(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}/` : null;
}

/** One person, many handles. Matches on LinkedIn URL, then email, then X handle, then exact name. */
export function upsertContact(c: Partial<Contact> & { name: string }): Contact {
  const linkedin = normaliseLinkedIn(c.linkedin_url);
  const email = c.email?.toLowerCase() ?? null;
  const x = c.x_handle?.replace(/^@/, "").toLowerCase() ?? null;
  const existing =
    (linkedin && get<Contact>("SELECT * FROM contacts WHERE linkedin_url = $v", { v: linkedin })) ||
    (email && get<Contact>("SELECT * FROM contacts WHERE email = $v", { v: email })) ||
    (x && get<Contact>("SELECT * FROM contacts WHERE x_handle = $v", { v: x })) ||
    get<Contact>("SELECT * FROM contacts WHERE lower(name) = lower($v)", { v: c.name.trim() });

  const row = {
    name: c.name.trim(),
    title: c.title ?? null,
    location: c.location ?? null,
    degree: c.degree ?? null,
    linkedin_url: linkedin,
    email,
    x_handle: x,
    phone: c.phone ?? null,
    notes: c.notes ?? null,
  };
  if (!existing) {
    run(
      `INSERT INTO contacts (name, title, location, degree, linkedin_url, email, x_handle, phone, notes)
       VALUES ($name, $title, $location, $degree, $linkedin_url, $email, $x_handle, $phone, $notes)`,
      row,
    );
    return get<Contact>("SELECT * FROM contacts WHERE rowid = last_insert_rowid()")!;
  }
  // Fill gaps only; never blank out a handle we already know.
  run(
    `UPDATE contacts SET
       title = coalesce($title, title), location = coalesce($location, location), degree = coalesce($degree, degree),
       linkedin_url = coalesce(linkedin_url, $linkedin_url), email = coalesce(email, $email),
       x_handle = coalesce(x_handle, $x_handle), phone = coalesce(phone, $phone), notes = coalesce(notes, $notes)
     WHERE id = $id`,
    { ...row, id: existing.id },
  );
  return get<Contact>("SELECT * FROM contacts WHERE id = $id", { id: existing.id })!;
}

export function upsertOutreach(o: Partial<Outreach> & { contact_id: number; opportunity_id: number | null }): Outreach {
  const existing = get<Outreach>(
    "SELECT * FROM outreach WHERE contact_id = $c AND opportunity_id IS $o",
    { c: o.contact_id, o: o.opportunity_id },
  );
  const fields = ["why_them", "hook", "hook_source", "connection_note", "alt_note", "full_dm", "send_time", "status", "reply", "sent_at", "replied_at"] as const;
  if (!existing) {
    run(
      `INSERT INTO outreach (opportunity_id, contact_id, ${fields.join(", ")})
       VALUES ($opportunity_id, $contact_id, ${fields.map((f) => "$" + f).join(", ")})`,
      {
        opportunity_id: o.opportunity_id,
        contact_id: o.contact_id,
        ...Object.fromEntries(fields.map((f) => [f, (o[f] ?? (f === "status" ? "drafted" : null)) as never])),
      },
    );
    return get<Outreach>("SELECT * FROM outreach WHERE rowid = last_insert_rowid()")!;
  }
  // Drafts can be refreshed while unsent. Once something is sent, only status and reply move.
  const sent = existing.status !== "drafted";
  const updates: Record<string, unknown> = {};
  for (const f of fields) {
    if (o[f] === undefined || o[f] === null) continue;
    if (sent && !["status", "reply", "sent_at", "replied_at"].includes(f)) continue;
    updates[f] = o[f];
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    run(`UPDATE outreach SET ${keys.map((k) => `${k} = $${k}`).join(", ")} WHERE id = $id`, {
      ...(updates as Record<string, never>),
      id: existing.id,
    });
  }
  return get<Outreach>("SELECT * FROM outreach WHERE id = $id", { id: existing.id })!;
}

export function outreachForOpportunity(opportunityId: number) {
  return all<Outreach & { name: string; title: string | null; linkedin_url: string | null; degree: string | null; location: string | null }>(
    `SELECT o.*, c.name, c.title, c.linkedin_url, c.degree, c.location
     FROM outreach o JOIN contacts c ON c.id = o.contact_id
     WHERE o.opportunity_id = $id ORDER BY o.id`,
    { id: opportunityId },
  );
}
