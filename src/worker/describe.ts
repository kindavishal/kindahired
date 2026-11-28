import { getOpportunity } from "../db/opportunities.ts";

/**
 * What a Claude Code call is doing, in words for the person: the desktop app shows it in the menu
 * bar ("Writing your resume for Toast…"). `label` is the call's own label, "<step>:<id or name>".
 */
export function describeStep(label: string): string {
  const [step, ...rest] = label.split(":");
  const ref = rest.join(":");
  const company = () => {
    const o = /^\d+$/.test(ref) ? getOpportunity(Number(ref)) : undefined;
    return o?.company.replace(/\s*\(.*\)\s*$/, "").trim() || null;
  };
  const at = (text: string, fallback: string) => { const c = company(); return c ? text.replace("{c}", c) : fallback; };
  switch (step) {
    case "posting": case "posting.parse": return at("Reading the {c} job post", "Reading a job post");
    case "fit": return at("Checking how well you fit {c}", "Checking how well you fit a role");
    case "resume": case "resume.fix": return at("Writing your resume for {c}", "Writing a resume");
    case "application": return at("Writing your {c} cover note and answers", "Writing a cover note");
    case "people": return at("Finding people to contact at {c}", "Finding people to contact");
    case "outreach": return at("Drafting notes to people at {c}", "Drafting notes to people");
    case "hiring": case "hiring.brief": return at("Finding who's hiring at {c}", "Finding who's hiring");
    case "status.review": return at("Checking where your {c} application stands", "Checking an application");
    case "profile": return ref ? `Looking up ${ref}` : "Looking someone up";
    case "company.screen": return ref ? `Checking open roles at ${ref}` : "Checking a company's open roles";
    case "source.extract": return "Reading a job page";
    case "x.screen": return "Reading job posts on X";
    case "gmail.classify": return "Sorting your job emails";
    case "identify": case "identify.parse": return "Matching an email to its role";
    case "evidence.extract": return "Reading your notes";
    case "profile.parse": return "Reading your profile";
    case "import.interpret": return "Reading the roles you imported";
    default: return "Preparing something for you";
  }
}
