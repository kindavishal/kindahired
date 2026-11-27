import nodemailer from "nodemailer";

/**
 * Email the hub sends itself: sign-in codes and "you're in" invites. Over SMTP, by default Gmail's
 * server with SMTP_USER (the Gmail address) and SMTP_PASS (an app password), from INVITE_FROM, an
 * alias set up in that Gmail account.
 */

export interface Mail { to: string; subject: string; text: string; html: string }
export type SendMail = (m: Mail) => Promise<void>;

export const mailFrom = (env: NodeJS.ProcessEnv = process.env) => env.INVITE_FROM || "kindahired <hired@kindavishal.dev>";

export function smtpSender(env: NodeJS.ProcessEnv = process.env): SendMail {
  return async (m) => {
    const { SMTP_USER: user, SMTP_PASS: pass } = env;
    if (!user || !pass) throw new Error("Email isn't set up: add SMTP_USER and SMTP_PASS to hub.env.");
    const transport = nodemailer.createTransport({ host: env.SMTP_HOST || "smtp.gmail.com", port: Number(env.SMTP_PORT || 587), secure: false, requireTLS: true, auth: { user, pass } });
    const from = mailFrom(env);
    await transport.sendMail({ from, to: m.to, replyTo: from, subject: m.subject, text: m.text, html: m.html });
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function codeMail(to: string, code: string): Mail {
  return {
    to,
    subject: `${code} is your kindahired code`,
    text: `Your kindahired sign-in code is ${code}\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.\n\nkindahired`,
    html: `<p>Your kindahired sign-in code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${esc(code)}</p><p>It works for 10 minutes. If you didn't ask for it, you can ignore this email.</p><p>kindahired</p>`,
  };
}
