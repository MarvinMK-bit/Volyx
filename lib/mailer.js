/* ============================================================
   MAILER — real delivery, no stubs
   ============================================================

   A verification code is useless if it only appears on screen. Four modes,
   picked automatically from the environment, in this order:

   1. GMAIL_USER + GMAIL_APP_PASSWORD   → Gmail SMTP (smtp.gmail.com:465)
      The quickest real setup: a Google account, 2-Step Verification on, then
      an "App password" (16 characters, spaces are ignored here). Mail then
      arrives in any inbox — Gmail, Outlook, Yahoo, school domains.
        GMAIL_USER=yourname@gmail.com
        GMAIL_APP_PASSWORD=abcd efgh ijkl mnop

   2. SMTP_HOST + SMTP_USER + SMTP_PASS → any SMTP relay
      Works with Gmail, Google Workspace, Brevo, Mailgun, SendGrid, Zoho,
      Mailtrap, or your school's own mail server.
        SMTP_HOST=smtp.gmail.com  SMTP_PORT=465  SMTP_SECURE=true

   3. SMTP_URL= smtps://user:pass@host:465 → same thing as one URL

   4. RESEND_API_KEY                     → Resend over HTTPS (no ports blocked)
      Best for production: a real sending domain, no per-account daily caps.

   5. none of the above                  → development mode: the code is
      printed in the server log and shown on screen, clearly labelled.

   Whatever is set, sendMail() only ever returns
   { delivered, transport, error? } — it never throws.
   ============================================================ */

import nodemailer from 'nodemailer';

const clean = (v) => String(v ?? '').trim();

/** Everything the transport needs, from whichever variables were provided. */
export function mailConfig() {
  const gmailUser = clean(process.env.GMAIL_USER);
  const user = gmailUser || clean(process.env.SMTP_USER);
  const rawPass = gmailUser ? process.env.GMAIL_APP_PASSWORD : process.env.SMTP_PASS;
  const host = clean(process.env.SMTP_HOST) || (gmailUser ? 'smtp.gmail.com' : '');
  const port = Number(process.env.SMTP_PORT || (host === 'smtp.gmail.com' ? 465 : 587));
  const secure = process.env.SMTP_SECURE
    ? clean(process.env.SMTP_SECURE).toLowerCase() === 'true'
    : port === 465;

  return {
    user,
    // Google prints app passwords in four groups; the spaces are not part of it.
    pass: String(rawPass ?? '').replace(/\s+/g, ''),
    host,
    port,
    secure,
    isGmail: host === 'smtp.gmail.com',
    url: clean(process.env.SMTP_URL),
  };
}

export function mailMode() {
  const c = mailConfig();
  if (c.url) return 'smtp';
  if (c.host && c.user && c.pass) return c.isGmail ? 'gmail' : 'smtp';
  if (process.env.RESEND_API_KEY) return 'resend';
  return 'dev';
}

/** True only when there is no way to send real mail. */
export function devCodeAllowed() {
  return mailMode() === 'dev';
}

/** The From: header. Gmail insists the sender is the authenticated account. */
export function mailFrom() {
  if (clean(process.env.MAIL_FROM)) return clean(process.env.MAIL_FROM);
  const c = mailConfig();
  if (c.user) return `Volyx <${c.user}>`;
  if (process.env.RESEND_API_KEY) return 'Volyx <onboarding@resend.dev>';
  return 'Volyx <no-reply@volyx.local>';
}

/** One line for the boot log and the admin screen. */
export function mailSummary() {
  const mode = mailMode();
  const c = mailConfig();
  return {
    mode,
    from: mailFrom(),
    host: c.host || (mode === 'resend' ? 'api.resend.com' : ''),
    user: c.user || '',
    real: mode !== 'dev',
  };
}

/* ---------------- transports ---------------- */

let cached = null;
let cachedKey = '';

function transport() {
  const mode = mailMode();
  if (mode !== 'gmail' && mode !== 'smtp') return null;

  const c = mailConfig();
  const key = `${mode}|${c.host}|${c.port}|${c.user}|${c.url}`;
  if (cached && cachedKey === key) return cached;

  cached = c.url
    ? nodemailer.createTransport(c.url)
    : nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.secure,
        auth: c.user ? { user: c.user, pass: c.pass } : undefined,
        // Fail in seconds, not minutes: a dead mail server must not hang signup.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        tls: { minVersion: 'TLSv1.2' },
      });
  cachedKey = key;
  return cached;
}

/**
 * Prove the mailbox works before anyone depends on it.
 * Called at boot and from the admin screen.
 */
export async function verifyMailer() {
  const mode = mailMode();
  if (mode === 'dev') {
    return { ok: false, mode, reason: 'No mail server configured — codes print in the log and appear on screen.' };
  }
  if (mode === 'resend') {
    return { ok: Boolean(process.env.RESEND_API_KEY), mode, host: 'api.resend.com' };
  }
  try {
    await transport().verify();
    const c = mailConfig();
    return { ok: true, mode, host: `${c.host}:${c.port}`, user: c.user };
  } catch (err) {
    return { ok: false, mode, reason: err.message };
  }
}

/* ---------------- sending ---------------- */

export async function sendMail({ to, subject, text, html, replyTo }) {
  const mode = mailMode();

  if (mode === 'gmail' || mode === 'smtp') {
    try {
      const info = await transport().sendMail({
        from: mailFrom(),
        to,
        replyTo: replyTo || undefined,
        subject,
        text,
        html,
      });
      console.log(`[mail] sent to ${to} via ${mode} (${info.messageId || 'ok'})`);
      return { delivered: true, transport: mode, id: info.messageId };
    } catch (err) {
      console.error(`[mail] ${mode} could not deliver to ${to}:`, err.message);
      return { delivered: false, transport: mode, error: friendlyMailError(err, mode) };
    }
  }

  if (mode === 'resend') {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: mailFrom(), to: [to], subject, text, html }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error('[mail] Resend rejected the message:', res.status, body);
        return { delivered: false, transport: 'resend', error: friendlyMailError(new Error(`${res.status} ${body}`), 'resend') };
      }
      return { delivered: true, transport: 'resend' };
    } catch (err) {
      console.error('[mail] Resend request failed:', err.message);
      return { delivered: false, transport: 'resend', error: friendlyMailError(err, 'resend') };
    }
  }

  console.log(`\n[mail:dev] to=${to}\n[mail:dev] subject=${subject}\n[mail:dev] ${text.split('\n')[0]}\n`);
  return { delivered: false, transport: 'dev', error: 'No mail server is configured.' };
}

/** Turn imap/smtp noise into something a teacher can act on. */
function friendlyMailError(err, mode) {
  const msg = String(err?.message || 'sending failed');
  if (/Invalid login|535|Username and Password not accepted|AUTH/i.test(msg)) {
    return mode === 'gmail'
      ? 'Gmail rejected the app password. Check GMAIL_USER and that GMAIL_APP_PASSWORD is a 16-character App password (2-Step Verification must be on).'
      : 'The mail server rejected the username or password.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'The mail server address could not be reached.';
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(msg)) return 'The mail server did not answer in time.';
  if (/self.signed|self signed|certificate/i.test(msg)) return 'The mail server certificate is not trusted.';
  return msg.slice(0, 200);
}

/* ---------------- templates (indigo, like the app) ---------------- */

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function template({ code, purpose, schoolName, minutes }) {
  const action =
    purpose === 'reset'
      ? 'reset your Volyx password'
      : purpose === 'verify'
        ? 'verify your Volyx account'
        : 'sign in to Volyx';

  const text = [
    `${code} is your Volyx code.`,
    '',
    `Use it to ${action}${schoolName ? ` for ${schoolName}` : ''}.`,
    `It expires in ${minutes} minutes and can only be used once.`,
    '',
    "If you didn't ask for this, you can ignore this email.",
  ].join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f1f5f9;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden">
    <div style="background:#0f172a;padding:20px 24px;color:#ffffff">
      <div style="font-size:20px;font-weight:700;letter-spacing:-.01em">Volyx</div>
      <div style="font-size:11px;color:#c7d2fe;letter-spacing:.14em;text-transform:uppercase;margin-top:3px">
        Educational portal
      </div>
    </div>
    <div style="padding:26px 24px">
      <p style="margin:0 0 14px;color:#334155;font-size:15px">Use this code to ${action}:</p>
      <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:.32em;color:#312e81;background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;padding:16px;text-align:center">${code}</div>
      <p style="margin:18px 0 0;color:#5b6b80;font-size:13px">It expires in ${minutes} minutes and can only be used once.</p>
      <p style="margin:6px 0 0;color:#5b6b80;font-size:13px">${schoolName ? escapeHtml(schoolName) + ' · ' : ''}Powered by Volyx</p>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e2e8f0;color:#5b6b80;font-size:12px">
      If you didn't ask for this code, you can ignore this email.
    </div>
  </div>
</div>`;

  return { subject: `${code} is your Volyx code`, text, html };
}

export async function sendVerificationCode({ to, code, purpose, schoolName }) {
  return sendMail({ to, ...template({ code, purpose, schoolName, minutes: 15 }) });
}

/* Student login details. Unlike a verification code this carries a real
   password, so it is sent to the address the teacher chose — never to the
   student's generated login address. */
function credentialsTemplate({ studentName, loginEmail, password, schoolName, signInUrl, guardianName, days }) {
  const subject = `${schoolName} · ${studentName}'s Volyx login`;
  const text = [
    `Hello ${studentName},`,
    '',
    `${guardianName || 'Your teacher'} created a Volyx account for your school results.`,
    '',
    `Sign-in address : ${loginEmail}`,
    `Temporary password: ${password}`,
    '',
    `Open ${signInUrl} and sign in with the details above. You'll be asked to choose your own password.`,
    `This temporary password expires in ${days} days.`,
    '',
    `${schoolName} · powered by Volyx`,
  ].join('\n');

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1e293b;line-height:1.55">
    <p>Hello ${escapeHtml(studentName)},</p>
    <p>${escapeHtml(guardianName || 'Your teacher')} created a Volyx account for your school results.</p>
    <table style="border-collapse:collapse;margin:18px 0">
      <tr><td style="padding:6px 16px 6px 0;color:#5b6b80">Sign-in address</td><td style="font-weight:600">${escapeHtml(loginEmail)}</td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#5b6b80">Temporary password</td><td style="font-family:ui-monospace,monospace;font-weight:600">${escapeHtml(password)}</td></tr>
    </table>
    <p><a href="${escapeHtml(signInUrl)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">Open Volyx</a></p>
    <p style="color:#5b6b80;font-size:13px">You'll be asked to choose your own password. This temporary password expires in ${days} days.</p>
  </div>`;

  return { subject, text, html };
}

export async function sendStudentCredentials({ to, studentName, loginEmail, password, schoolName, signInUrl, guardianName, days = 30 }) {
  return sendMail({ to, ...credentialsTemplate({ studentName, loginEmail, password, schoolName, signInUrl, guardianName, days }) });
}
