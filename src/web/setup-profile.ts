import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { z } from "zod";
import { PATHS, ROOT, type Profile } from "../config.ts";
import { llm } from "../llm/client.ts";
import { backToSetup, errorBox, hubMode, readForm, refuseCrossOrigin, sameOrigin, sendHtml } from "./forms.ts";
import { esc, page } from "./ui.ts";

/**
 * Profile editor, for hub mode (JH_HUB=1): every field of the Profile type, saved to PATHS.profile
 * as pretty JSON. "Fill from my resume text" runs the profile.parse quick step on pasted text and
 * only fills the form; nothing is saved until Save.
 */

const EXAMPLE = path.join(ROOT, "context", "profile.example.json");

function readProfile(): Partial<Profile> | null {
  try { return JSON.parse(readFileSync(PATHS.profile, "utf8")) as Partial<Profile>; } catch { return null; }
}

/** Done once the profile has a name and a target and isn't the untouched example. */
export function profileDone(): boolean {
  const p = readProfile();
  if (!p?.name?.trim() || !p.targets?.length) return false;
  try {
    return JSON.stringify(p) !== JSON.stringify(JSON.parse(readFileSync(EXAMPLE, "utf8")));
  } catch {
    return true;
  }
}

const lines = (s: string | null) => (s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const isUrl = (s: string) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** The raw text of each field, as the form shows it. */
type Draft = Record<"name" | "headline" | "location" | "email" | "phone" | "portfolio" | "links" | "targets" | "keywords", string>;

function draftOf(p: Partial<Profile> | null): Draft {
  return {
    name: p?.name ?? "", headline: p?.headline ?? "", location: p?.location ?? "", email: p?.email ?? "",
    phone: p?.phone ?? "", portfolio: p?.portfolio ?? "",
    links: (p?.links ?? []).map((l) => `${l.label}: ${l.url}`).join("\n"),
    targets: (p?.targets ?? []).join("\n"), keywords: (p?.keywords ?? []).join("\n"),
  };
}

/** Checks the form and builds the Profile. Errors are in the person's words. */
export function parseProfileForm(form: URLSearchParams): { profile: Profile | null; errors: string[]; draft: Draft } {
  const f = (k: keyof Draft) => (form.get(k) ?? "").trim();
  const draft = Object.fromEntries((["name", "headline", "location", "email", "phone", "portfolio", "links", "targets", "keywords"] as const)
    .map((k) => [k, form.get(k) ?? ""])) as Draft;
  const errors: string[] = [];
  const single = { name: f("name"), headline: f("headline"), location: f("location"), email: f("email"), phone: f("phone"), portfolio: f("portfolio") };
  if (!single.name) errors.push("Add your name.");
  if (!single.email) errors.push("Add your email.");
  else if (!isEmail(single.email)) errors.push(`"${single.email}" doesn't look like an email address.`);
  if (single.portfolio && !isUrl(single.portfolio)) errors.push("The portfolio link must start with https://.");
  for (const [k, v] of Object.entries(single)) if (v.length > 300) errors.push(`${k} is too long (300 characters at most).`);

  const links: Profile["links"] = [];
  for (const line of lines(form.get("links"))) {
    const m = line.match(/^(.+?):\s+(\S+)$/);
    if (!m || !isUrl(m[2])) { errors.push(`Write each link as "Label: https://…". This line isn't: ${line}`); continue; }
    links.push({ label: m[1].trim(), url: m[2] });
  }
  const targets = lines(form.get("targets"));
  if (!targets.length) errors.push("Add at least one target role, one per line.");
  const keywords = lines(form.get("keywords"));
  if (targets.length > 30 || keywords.length > 50 || links.length > 20) errors.push("That's too many lines. Keep to 30 targets, 50 keywords and 20 links.");

  if (errors.length) return { profile: null, errors, draft };
  return { profile: { ...single, links, targets, keywords }, errors, draft };
}

export function saveProfile(p: Profile): void {
  mkdirSync(path.dirname(PATHS.profile), { recursive: true });
  const tmp = `${PATHS.profile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n");
  renameSync(tmp, PATHS.profile);
}

const Parsed = z.object({
  name: z.string(), headline: z.string(), location: z.string(), email: z.string(), phone: z.string(), portfolio: z.string(),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  targets: z.array(z.string()),
});

async function fromResume(text: string): Promise<Partial<Profile>> {
  return llm.structured("profile.parse", Parsed, {
    effort: "low",
    system: "Read a resume and fill in a job seeker's profile. Use only what the resume says; leave a field empty when it isn't there. " +
      "headline is their current or most recent title. links are LinkedIn, GitHub and other profile links, labelled by site. " +
      "portfolio is a personal site, if any. targets are 1 to 3 role families their experience points to, such as \"Product marketing / go-to-market\".",
    prompt: text.slice(0, 30_000),
  });
}

const field = (id: keyof Draft, label: string, d: Draft, type = "text", hint = "") =>
  `<div class="form-row"><label for="p-${id}">${label}</label>${hint ? `<p class="hint">${hint}</p>` : ""}<input id="p-${id}" type="${type}" name="${id}" value="${esc(d[id])}" maxlength="300"${id === "name" || id === "email" ? " required" : ""}></div>`;
const area = (id: keyof Draft, label: string, d: Draft, hint: string) =>
  `<div class="form-row"><label for="p-${id}">${label}</label><p class="hint">${hint}</p><textarea class="field" id="p-${id}" name="${id}"${id === "targets" ? " required" : ""}>${esc(d[id])}</textarea></div>`;

function profilePage(d: Draft, o: { errors?: string[]; flash?: string | null; filled?: boolean } = {}): string {
  return page("Profile · Job hunt", `<div class="stack setup">${backToSetup}
<div><h1>Your profile</h1><p class="lede">Your name and links go on every resume and note. Your target roles decide which job alerts are worth a closer look.</p></div>
${errorBox(o.errors ?? [])}${o.filled ? `<div class="callout accent"><p>Filled from your resume. Check each field, then save.</p></div>` : ""}
<form method="post" action="/setup/profile" class="stack"><input type="hidden" name="intent" value="save">
<div class="panel">
${field("name", "Name", d)}${field("headline", "Headline", d, "text", "Your current or most recent title.")}
${field("location", "Location", d)}${field("email", "Email", d, "email")}${field("phone", "Phone", d)}
${field("portfolio", "Portfolio", d, "url", "A personal site, if you have one.")}
${area("links", "Links", d, "One per line, as <code>Label: https://…</code>. For example <code>LinkedIn: https://www.linkedin.com/in/you</code>.")}
${area("targets", "Target roles", d, "One role family per line, such as <code>Product marketing / go-to-market</code>.")}
${area("keywords", "Search phrases", d, "Optional. One per line. Short phrases used in Gmail, X and LinkedIn searches. Left empty, they come from your target roles.")}
</div>
<div class="btn-row"><button class="btn primary">Save profile</button></div></form>
<form method="post" action="/setup/profile" class="stack"><input type="hidden" name="intent" value="parse">
<section><div class="section-head"><h2>Fill from my resume text</h2></div><div class="panel">
<div class="form-row"><label for="p-resume">Resume text</label><p class="hint">Paste the text of your resume. The fields above are filled in for you to check. Nothing is saved until you press Save profile.</p>
<textarea class="field" id="p-resume" name="resume"></textarea></div></div></section>
<div class="btn-row"><button class="btn">Fill the form</button></div></form>
</div>`, { tab: "setup", flash: o.flash });
}

/** Handles /setup/profile. Returns false for any other path. */
export async function setupProfileRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/setup/profile" || !hubMode()) return false;
  if (req.method === "GET") {
    sendHtml(res, 200, profilePage(draftOf(readProfile()), { flash: url.searchParams.get("flash") }));
    return true;
  }
  if (req.method !== "POST") return false;
  if (!sameOrigin(req)) { refuseCrossOrigin(res); return true; }
  const form = await readForm(req);
  if (!form) { sendHtml(res, 413, profilePage(draftOf(readProfile()), { errors: ["That was too much text. Paste less and try again."] })); return true; }

  if (form.get("intent") === "parse") {
    const text = (form.get("resume") ?? "").trim();
    if (text.length < 50) {
      sendHtml(res, 400, profilePage(draftOf(readProfile()), { errors: ["Paste the text of your resume first."] }));
      return true;
    }
    try {
      const found = await fromResume(text);
      const keep = readProfile();
      sendHtml(res, 200, profilePage(draftOf({ ...found, keywords: keep?.keywords ?? [] }), { filled: true }));
    } catch (err) {
      sendHtml(res, 502, profilePage(draftOf(readProfile()), { errors: [`The resume couldn't be read: ${err instanceof Error ? err.message : err}`] }));
    }
    return true;
  }

  const { profile, errors, draft } = parseProfileForm(form);
  if (!profile) { sendHtml(res, 400, profilePage(draft, { errors })); return true; }
  saveProfile(profile);
  res.writeHead(303, { location: "/setup/profile?flash=" + encodeURIComponent("Profile saved."), "cache-control": "no-store" });
  res.end();
  return true;
}
