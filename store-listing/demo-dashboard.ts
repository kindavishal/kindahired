// Runs the real dashboard on an in-memory database filled with made-up roles, people and
// interviews, for the Microsoft Store screenshots. Nothing here is real data, and nothing leaves the
// machine: Telegram is off and no sync runs.
//   npx tsx store-listing/demo-dashboard.ts   → http://127.0.0.1:4390
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
Object.assign(process.env, {
  JH_DATA_DIR: mkdtempSync(path.join(os.tmpdir(), "kh-demo-")),
  JH_PROFILE: path.join(root, "context", "profile.example.json"),
  JH_PLAYBOOK: path.join(root, "context", "playbook.example.md"),
  JH_TIMEZONE: "Asia/Kolkata",
  MY_EMAILS: "sam@example.com",
  JH_NO_TELEGRAM: "1",
  GEMINI_API_KEY: "",
  FIRECRAWL_API_KEY: "",
});

const { run, useMemoryDb } = await import("../src/db/index.ts");
const { upsertOpportunity, updateOpportunity } = await import("../src/db/opportunities.ts");
const { upsertContact, upsertOutreach } = await import("../src/db/contacts.ts");
const { startServer } = await import("../src/web/server.ts");

useMemoryDb();

const now = Date.now();
const at = (days: number, hour = 10, minute = 0) => {
  const d = new Date(now + days * 86_400_000);
  d.setUTCHours(hour - 5, minute - 30, 0, 0); // hour is IST
  return d.toISOString();
};
const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
const dateOnly = (days: number) => at(days).slice(0, 10);

// ---------- Roles ----------

const halcyon = upsertOpportunity("Halcyon Labs", "Developer Relations Lead", {
  status: "ready",
  source: "gmail",
  apply_url: "https://jobs.example.com/halcyon/devrel-lead",
  fit_verdict: "apply",
  pay: "$150k–175k, remote",
  closes_on: dateOnly(3),
  fit_read:
    "Strong match. They want someone to build their developer community from about 2,000 to 20,000 people, run the ambassador program and own docs feedback. You grew the Quarry community from 1,500 to 18,000 and ran a 40-person champions program, which is the closest thing on your record.\n\nThe gap is SDK experience in Rust: name your Go SDK work and say you'd pair with their engineers on the Rust one, rather than claim it.",
  next_step: "Apply before Friday. The hiring manager posted about the role on LinkedIn on Monday; a short note to her first will help.",
  cover_note:
    "Hi Priya,\n\nYour post about taking Halcyon's community from early adopters to everyday builders is the job I've done for the last three years. At Quarry I grew the developer community from 1,500 to 18,000, set up a 40-person champions program that now answers a third of forum questions, and turned docs feedback into a monthly review with the SDK team.\n\nI'd bring the same playbook to Halcyon: ship the ambassador program in the first quarter, measure it by questions answered and builds shipped, not by headcount.\n\nSam",
  form_answers:
    "Why Halcyon? Your API is the one I reach for in side projects, and your forum shows a community ready for more structure.\nNotice period: 30 days.\nWork authorisation: no sponsorship needed.",
  pack_status: "ready",
  pack_ready_at: ago(0.2),
  jd_text: "Developer Relations Lead. Own the developer community, ambassador program and docs feedback loop.",
});
const lumen = upsertOpportunity("Lumen Cloud", "Community Programs Manager", {
  status: "interviewing",
  source: "linkedin_saved",
  fit_verdict: "apply",
  pay: "₹48–55 LPA",
  fit_read: "Strong match on community programs and events. They're opening an India hub and want someone to run meetups across four cities.",
  cover_note: "Hi Dana,\n\nThanks for the quick reply. Saturday works well; I'll bring a 90-day plan for the India meetups.\n\nSam",
  pack_status: "ready",
  date_applied: dateOnly(-9),
});
const fernbank = upsertOpportunity("Fernbank", "Head of Developer Community", {
  status: "decide",
  source: "x:search",
  fit_verdict: "stretch",
  closes_on: dateOnly(6),
  fit_read: "A stretch: they want eight years of people management and you have four. Worth it if you lead with the champions program as team-building.",
  pack_status: "ready",
});
const quarry = upsertOpportunity("Northgate Data", "Developer Advocate", {
  status: "applied",
  source: "web",
  fit_verdict: "apply",
  date_applied: dateOnly(-6),
  pack_status: "ready",
});
upsertOpportunity("Tessellate", "Partner Engineer", { status: "skipped", source: "gmail", fit_verdict: "skip", skip_reason: "Mostly solutions engineering; little community work." });
upsertOpportunity("Copperline", "Developer Experience Manager", { status: "ready", source: "gmail", fit_verdict: "apply", closes_on: dateOnly(5), pack_status: "ready" });
upsertOpportunity("Brightloop", "Community Manager, APAC", { status: "applied", source: "telegram", fit_verdict: "apply", date_applied: dateOnly(-12), pack_status: "ready" });

// ---------- People ----------

const priya = upsertContact({ name: "Priya Raman", title: "Director of Developer Relations, Halcyon Labs", degree: "2nd", linkedin_url: "https://www.linkedin.com/in/example-priya" });
const marcus = upsertContact({ name: "Marcus Hale", title: "Senior Recruiter, Halcyon Labs", degree: "3rd", linkedin_url: "https://www.linkedin.com/in/example-marcus" });
const dana = upsertContact({ name: "Dana Wu", email: "dana@lumen.example", title: "Head of Community, Lumen Cloud", linkedin_url: "https://www.linkedin.com/in/example-dana" });

const priyaOut = upsertOutreach({
  contact_id: priya.id,
  opportunity_id: halcyon.id,
  why_them: "Hiring manager: she posted the role on Monday and the team reports to her.",
  hook_source: "Her LinkedIn post: “We’re hiring someone to grow builders, not followers.”",
  send_time: "Tuesday morning, her time",
  connection_note: "Hi Priya, your post on growing builders, not followers, is how I ran Quarry's community (1.5k to 18k). Applying for the DevRel Lead role this week; would love to connect.",
  status: "drafted",
});
upsertOutreach({
  contact_id: marcus.id,
  opportunity_id: halcyon.id,
  why_them: "Recruiter on the role, per the job post.",
  connection_note: "Hi Marcus, I'm applying for Halcyon's Developer Relations Lead role. Happy to share anything that helps the shortlist.",
  status: "drafted",
});
upsertOutreach({ contact_id: dana.id, opportunity_id: lumen.id, why_them: "Hiring manager.", status: "dm_sent", sent_at: ago(8), replied_at: ago(2), reply: "Looking forward to Saturday. Bring your India plan." });

// ---------- Interview ----------

run(`INSERT INTO meetings (event_id, opportunity_id, title, start_at, end_at, status, join_url, attendees)
     VALUES ('demo-1', $o, 'Dana / Sam: second round', $s, $e, 'confirmed', 'https://meet.example.com/abc', $a)`,
  { o: lumen.id, s: at(2, 15), e: at(2, 16), a: JSON.stringify([{ email: "dana@lumen.example", name: "Dana Wu" }]) });
run("INSERT INTO threads (channel, external_id, opportunity_id, contact_id, subject, kind, last_message_at, last_from, last_snippet) VALUES ('email', 'demo-t1', $o, $c, 'Next steps: Community Programs Manager', 'conversation', $t, 'them', 'Looking forward to Saturday. Bring your India plan.')",
  { o: lumen.id, c: dana.id, t: ago(2) });
run("INSERT INTO messages (thread_id, external_id, from_me, sender, sent_at, body) VALUES (1, 'demo-m1', 0, 'Dana Wu <dana@lumen.example>', $t, 'Looking forward to Saturday. Bring your India plan, and one meetup you ran that didn''t go to plan.')", { t: ago(2) });

// ---------- Today's list ----------
// The dashboard works out the tasks itself from the roles, people and interviews above.

updateOpportunity(halcyon.id, { next_step: "Apply before Friday, after a short note to Priya." });

startServer(4390);
console.log("Demo dashboard on http://127.0.0.1:4390");
