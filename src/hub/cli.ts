import { adminCommands } from "./admin.ts";
import { loadHubEnv } from "./router.ts";

/** Hub admin commands: `npm run hub -- <command> [args]`. */

type Command = { usage: string; run: (args: string[]) => Promise<void> };

const commands: Record<string, Command> = {
  "telegram:webhook": {
    usage: "telegram:webhook <public url>   point the bot's webhook at the hub (adds /telegram/webhook to a bare domain)",
    async run([raw]) {
      if (!raw) throw new Error("Give the hub's public URL, for example https://hub.example.com/");
      const token = process.env.TELEGRAM_BOT_TOKEN, secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (!token || !secret) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.");
      const url = new URL(raw);
      if (url.pathname === "/" || url.pathname === "") url.pathname = "/telegram/webhook";
      const base = (process.env.TELEGRAM_UPSTREAM_API ?? "https://api.telegram.org").replace(/\/+$/, "");
      const res = await fetch(`${base}/bot${token}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.toString(), secret_token: secret, allowed_updates: ["message", "callback_query"] }),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) throw new Error(`setWebhook: ${json.description}`);
      console.log(`Webhook set to ${url}`);
    },
  },
};

for (const [name, run] of Object.entries(adminCommands)) {
  commands[name] = { usage: name === "add-person" ? "add-person <id> <email>    create a person's data folder, port and secrets" : "list                       list people on the hub", async run(args) { for (const line of run(args)) console.log(line); } };
}

const help = () => console.log(`Usage: npm run hub -- <command>\n\n${Object.values(commands).map((c) => `  ${c.usage}`).join("\n")}`);

loadHubEnv();
const [name, ...args] = process.argv.slice(2);
const cmd = name ? commands[name] : undefined;
if (!cmd) {
  help();
  process.exit(name && name !== "help" ? 1 : 0);
}
try {
  await cmd.run(args);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
