import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loadProfile, PATHS, type Profile } from "../config.ts";
import type { Resume } from "./schema.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Matches the layout of my existing resumes: serif headings, sans body, one column, A4. My name
 * appears once, as the title. No running page header or "Page 1 of 3" footer: those are browser
 * print furniture and make the PDF look machine-made.
 */
export function resumeHtml(r: Resume, profile: Profile = loadProfile(), o: { edit?: boolean } = {}): string {
  const contact = [
    esc(profile.location), esc(profile.email), esc(profile.phone),
    ...profile.links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`),
  ].join(" · ");
  const fill = (s: string) => esc(s).replace(/\[(FILL|TODO|TBD|ADD|INSERT)[^\]]*\]/gi, (m) => `<mark>${m}</mark>`);
  /** In edit mode each piece of text is its own editable field, keyed back to the resume content. */
  const ed = (f: string, text: string | null, hint = "", tag = "span") =>
    o.edit ? `<${tag} data-f="${f}" contenteditable="plaintext-only" spellcheck="true"${hint ? ` data-hint="${esc(hint)}"` : ""}>${fill(text ?? "")}</${tag}>` : fill(text ?? "");
  const note = (f: string, text: string | null) =>
    o.edit ? `<span class="paren">${ed(f, text, "add a note")}</span>` : text ? ` (${esc(text)})` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(profile.name)}, Resume</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1f1f1f; font: 10.6pt/1.5 Inter, "Helvetica Neue", Arial, sans-serif; }
  h1, h2, h3 { font-family: "Source Serif 4", Georgia, serif; font-weight: 400; color: #141414; margin: 0; }
  h1 { font-size: 27pt; line-height: 1.1; margin-bottom: 8pt; letter-spacing: -0.01em; }
  h2 { font-size: 16pt; margin: 20pt 0 6pt; }
  h3 { font-size: 12.5pt; margin: 12pt 0 4pt; line-height: 1.3; }
  .headline { margin-bottom: 6pt; }
  .headline b { font-weight: 600; }
  .contact a { color: #2a5bd7; }
  p { margin: 0 0 4pt; }
  ul { margin: 2pt 0 0; padding-left: 16pt; }
  li { margin-bottom: 3pt; }
  h3, li { break-inside: avoid; }
  h2, h3 { break-after: avoid; }
  b { font-weight: 600; }
  mark { background: #fff3a3; }
${o.edit ? EDIT_CSS : ""}</style></head><body>
<h1>${esc(profile.name)}</h1>
<div class="headline"><b>${ed("headline", r.headline, "role family")}</b> | ${o.edit ? ed("specialties", r.specialties.join(" · "), "specialties, separated by ·") : r.specialties.map(esc).join(" · ")}</div>
<div class="contact">${contact}</div>

<h2>Summary</h2>
<p>${ed("summary", r.summary.text, "summary")}</p>

<h2>Experience</h2>
${r.experience
  .map(
    (e, i) => `<h3>${ed(`exp.${i}.title`, e.title, "title")} — ${ed(`exp.${i}.company`, e.company, "company")}${note(`exp.${i}.company_note`, e.company_note)} · ${ed(`exp.${i}.dates`, e.dates, "dates")}</h3>
<ul${o.edit ? ` data-list="exp.${i}.bullet"` : ""}>${e.bullets.map((b, j) => (o.edit ? ed(`exp.${i}.bullet.${j}`, b.text, "bullet", "li") : `<li>${fill(b.text)}</li>`)).join("")}</ul>`,
  )
  .join("\n")}

${r.projects.length ? `<h2>Projects I've built</h2>
<ul>${r.projects.map((p, i) => `<li><b>${ed(`proj.${i}.name`, p.name, "name")}</b>${o.edit ? ` (${ed(`proj.${i}.link`, p.link, "link")})` : p.link ? ` (${esc(p.link)})` : ""}: ${ed(`proj.${i}.text`, p.text, "what it is")}</li>`).join("")}</ul>` : ""}

${r.community.length ? `<h2>Hackathons, community and open source</h2>
<ul>${r.community.map((c, i) => `<li><b>${ed(`comm.${i}.lead`, c.lead, "lead")}</b>${o.edit ? ` ${ed(`comm.${i}.text`, c.text, "details")}` : c.text ? ` ${fill(c.text)}` : ""}</li>`).join("")}</ul>` : ""}

<h2>Education and certifications</h2>
${o.edit ? `<div data-list="edu">${(r.education.length ? r.education : [""]).map((e, i) => ed(`edu.${i}`, e, "degree, institution, years", "p")).join("")}</div>` : r.education.map((e) => `<p>${fill(e)}</p>`).join("")}
${o.edit ? `<p>${ed("certs", r.certifications.join(" · "), "certifications, separated by ·")}</p>` : r.certifications.length ? `<p>${r.certifications.map(fill).join(" · ")}</p>` : ""}

<h2>Skills</h2>
${r.skills.map((s, i) => `<p><b>${ed(`skill.${i}.label`, s.label, "label")}:</b> ${ed(`skill.${i}.items`, s.items, "skills")}</p>`).join("")}
</body></html>`;
}

const EDIT_CSS = `
  html { background: #ecebe7; }
  body { background: #fff; max-width: 210mm; min-height: 297mm; margin: 0 auto; padding: 18mm; }
  [data-f] { border-radius: 2px; outline: none; transition: background-color .12s; }
  [data-f]:hover { background: #f3f1ec; }
  [data-f]:focus { background: #e8eefc; box-shadow: 0 0 0 2px #e8eefc; }
  [data-f]:empty::before { content: attr(data-hint); color: #9a978f; font-style: italic; }
  .paren:has(> :not(:empty))::before { content: " ("; }
  .paren:has(> :not(:empty))::after { content: ")"; }
  .paren:has(> :empty) { margin-left: 4px; opacity: 0; }
  h3:hover .paren, .paren:focus-within { opacity: 1; }
  mark { background: #ffe27a; box-shadow: 0 0 0 1px #d9a400; }
`;

export async function renderResumePdf(r: Resume, fileName: string): Promise<string> {
  const profile = loadProfile();
  const out = path.join(PATHS.resumes, fileName.replace(/[^\w.-]+/g, "_"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(resumeHtml(r, profile), { waitUntil: "networkidle" });
    await page.pdf({
      path: out,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: "18mm", bottom: "18mm", left: "18mm", right: "18mm" },
    });
  } finally {
    await browser.close();
  }
  // The content is kept next to the PDF, so a layout change can re-render it without the AI.
  writeFileSync(out.replace(/\.pdf$/i, ".json"), JSON.stringify(r, null, 2));
  return out;
}

/** Re-renders a resume from the content saved next to its PDF. */
export async function rerenderResumePdf(pdfPath: string): Promise<string> {
  const r = JSON.parse(readFileSync(pdfPath.replace(/\.pdf$/i, ".json"), "utf8")) as Resume;
  return renderResumePdf(r, path.basename(pdfPath));
}
