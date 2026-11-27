import { logEvent } from "../db/index.ts";
import { llm } from "../llm/client.ts";
import { firecrawlAvailable, firecrawlSearch, FirecrawlUnavailable } from "../sources/firecrawl.ts";
import { findProfileOnLinkedIn, LinkedInUnavailable } from "../sources/linkedin.ts";

/** Finding a named person's LinkedIn and X profiles, and search links for when they can't be found. */

const bareCompany = (company: string) => company.replace(/\(.*?\)/g, "").trim();

export const isLinkedInProfile = (url: string | null | undefined): url is string => !!url && /linkedin\.com\/in\/[^/?#\s]+/i.test(url);
export const isXProfile = (url: string | null | undefined): url is string =>
  !!url && /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?!search|home|explore|i\/|intent|hashtag)[A-Za-z0-9_]{1,15}\/?$/i.test(url);

/** A LinkedIn people search for this person: what to link when no profile was found. */
export const linkedInSearchUrl = (name: string, company: string) =>
  `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${name} ${bareCompany(company)}`)}`;
/** An X people search for this person. */
export const xSearchUrl = (name: string, company: string) =>
  `https://x.com/search?q=${encodeURIComponent(`${name} ${bareCompany(company)}`)}&f=user`;

/** The person's linkedin.com/in/ profile: my logged-in search first, then a web search, then a short research step. Null if none found. */
export async function findLinkedInProfile(name: string, company: string): Promise<string | null> {
  try {
    const found = await findProfileOnLinkedIn(name, company);
    if (found) return found;
  } catch (err) {
    if (!(err instanceof LinkedInUnavailable)) logEvent("profile.lookup_failed", name, String(err));
  }
  // One Firecrawl search (2 credits) usually finds the profile; the result must carry their surname.
  if (firecrawlAvailable()) {
    try {
      const results = await firecrawlSearch(`${name} ${bareCompany(company)} site:linkedin.com/in`, { limit: 5, label: `profile:${name}` });
      const surname = name.trim().split(/\s+/).pop()!.toLowerCase();
      const hit = results.find((r) => isLinkedInProfile(r.url) && `${r.title} ${r.url}`.toLowerCase().includes(surname));
      if (hit) return hit.url.replace(/[?#].*$/, "");
    } catch (err) {
      if (!(err instanceof FirecrawlUnavailable)) logEvent("firecrawl.failed", name, String(err).slice(0, 200));
    }
  }
  try {
    const notes = await llm.research(`profile:${name}`, {
      effort: "low", maxSearches: 2,
      system: "Find one person's public LinkedIn profile URL.",
      prompt: `LinkedIn profile URL (linkedin.com/in/...) of ${name}, who works at ${company}. Reply with the URL only, or "none".`,
    });
    const url = notes.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s)"'\]>]+/i)?.[0];
    if (url) return url.replace(/[.,;]+$/, "");
  } catch { /* none found */ }
  return null;
}
