import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { OAuth2Client } from "google-auth-library";
import { env, PATHS } from "../config.ts";

// Read-only Gmail: the tool never sends email. Sheets is read/write for the tracker. Drive is
// limited to files this tool creates (the resume PDFs), nothing else in your Drive. Calendar is
// read-only, for interview times.
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  CALENDAR_SCOPE,
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];
const REDIRECT_PORT = 53682;

function client(): OAuth2Client {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env. See README, step 2.");
  }
  return new OAuth2Client({
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: `http://127.0.0.1:${REDIRECT_PORT}/callback`,
  });
}

export function googleConnected(): boolean {
  return existsSync(PATHS.googleToken);
}

/** Whether the saved login includes a permission (older logins may predate the Drive one). */
export function hasScope(scope: string): boolean {
  if (!googleConnected()) return false;
  const { scope: granted = "" } = JSON.parse(readFileSync(PATHS.googleToken, "utf8")) as { scope?: string };
  return granted.split(" ").includes(scope);
}

/** Authorised client, refreshing and saving tokens as needed. */
export function googleClient(): OAuth2Client {
  if (!googleConnected()) throw new Error("Google is not connected. Run: npm run jh -- auth:google");
  const c = client();
  c.setCredentials(JSON.parse(readFileSync(PATHS.googleToken, "utf8")));
  c.on("tokens", (tokens) => {
    const saved = JSON.parse(readFileSync(PATHS.googleToken, "utf8"));
    writeFileSync(PATHS.googleToken, JSON.stringify({ ...saved, ...tokens }, null, 2), { mode: 0o600 });
  });
  return c;
}

/** One-time consent flow in the browser, with a local callback. */
export async function connectGoogle(): Promise<void> {
  const c = client();
  const url = c.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${REDIRECT_PORT}`);
      if (u.pathname !== "/callback") return void res.end();
      const got = u.searchParams.get("code");
      res.end(got ? "Connected. You can close this tab." : "No code received.");
      server.close();
      got ? resolve(got) : reject(new Error(u.searchParams.get("error") ?? "No code"));
    });
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      console.log("\nOpen this link to connect Google (Gmail and Calendar read-only, Sheets):\n\n" + url + "\n");
    });
  });
  const { tokens } = await c.getToken(code);
  writeFileSync(PATHS.googleToken, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log("Google connected.");
}
