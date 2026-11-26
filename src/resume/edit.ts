import { hasPlaceholder, type Resume } from "./schema.ts";

/**
 * My edits from the resume editor, as [field, text] pairs in page order. Field keys come from
 * resumeHtml's edit mode: "summary", "exp.0.bullet.2", "exp.0.bullet.new", "edu.1", "skill.3.items".
 */
export type Edits = [string, string][];

const clean = (t: string) => t.replace(/ /g, " ").replace(/\s+/g, " ").trim();
const splitDots = (t: string) => t.split(/\s*·\s*/).map(clean).filter(Boolean);

/**
 * Applies my edits to the saved content. A line I empty is removed; a line I add (Enter in a
 * bullet or education line) is kept. Edited lines keep the evidence they cited: I'm the source
 * of truth here, so nothing I typed is sent back through the evidence check.
 */
export function applyEdits(r: Resume, edits: Edits): Resume {
  const map = new Map<string, string>();
  const order: string[] = [];
  edits.forEach(([f, v], i) => {
    const key = f.endsWith(".new") ? `${f}#${i}` : f;
    map.set(key, clean(v));
    order.push(key);
  });
  const val = (f: string, fallback: string) => (map.has(f) ? map.get(f)! : fallback);
  const listOf = (prefix: string) => order.filter((k) => k.startsWith(prefix + "."));

  return {
    ...r,
    headline: val("headline", r.headline),
    specialties: map.has("specialties") ? splitDots(map.get("specialties")!) : r.specialties,
    summary: { ...r.summary, text: val("summary", r.summary.text) },
    experience: r.experience
      .map((e, i) => {
        const keys = listOf(`exp.${i}.bullet`);
        const bullets = keys.length
          ? keys.map((k) => {
            const j = k.split(".")[3];
            return { text: map.get(k)!, evidence: /^\d+$/.test(j) ? e.bullets[Number(j)]?.evidence ?? [] : [] };
          }).filter((b) => b.text)
          : e.bullets;
        const note = val(`exp.${i}.company_note`, e.company_note ?? "");
        return {
          ...e,
          title: val(`exp.${i}.title`, e.title),
          company: val(`exp.${i}.company`, e.company),
          company_note: note || null,
          dates: val(`exp.${i}.dates`, e.dates),
          bullets,
        };
      })
      .filter((e) => e.title || e.company || e.bullets.length),
    projects: r.projects
      .map((p, i) => ({ ...p, name: val(`proj.${i}.name`, p.name), link: val(`proj.${i}.link`, p.link ?? "") || null, text: val(`proj.${i}.text`, p.text) }))
      .filter((p) => p.name || p.text),
    community: r.community
      .map((c, i) => ({ ...c, lead: val(`comm.${i}.lead`, c.lead), text: val(`comm.${i}.text`, c.text) }))
      .filter((c) => c.lead || c.text),
    education: listOf("edu").length ? listOf("edu").map((k) => map.get(k)!).filter(Boolean) : r.education,
    certifications: map.has("certs") ? splitDots(map.get("certs")!) : r.certifications,
    skills: r.skills
      .map((s, i) => ({ label: val(`skill.${i}.label`, s.label), items: val(`skill.${i}.items`, s.items) }))
      .filter((s) => s.label || s.items),
  };
}

/** Every field that still holds a [FILL IN]-style blank, so the PDF never ships with one. */
export function blanksIn(r: Resume): string[] {
  const out: string[] = [];
  const add = (where: string, t: string | null) => { if (hasPlaceholder(t)) out.push(where); };
  add("Headline", r.headline);
  r.specialties.forEach((s) => add("Specialties", s));
  add("Summary", r.summary.text);
  r.experience.forEach((e) => {
    add(e.company, `${e.title} ${e.company} ${e.company_note ?? ""} ${e.dates}`);
    e.bullets.forEach((b, j) => add(`${e.company}, bullet ${j + 1}`, b.text));
  });
  r.projects.forEach((p) => add(`Project ${p.name}`, `${p.name} ${p.link ?? ""} ${p.text}`));
  r.community.forEach((c) => add(c.lead || "Community", `${c.lead} ${c.text}`));
  r.education.forEach((e) => add("Education", e));
  r.certifications.forEach((c) => add("Certifications", c));
  r.skills.forEach((s) => add(`Skills: ${s.label}`, `${s.label} ${s.items}`));
  return [...new Set(out)];
}
