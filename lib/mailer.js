/* ============================================================
   MAILER
   Verification codes have to reach a real inbox. Three modes:

   1. RESEND_API_KEY set      → real delivery through Resend (HTTP, no deps)
   2. SMTP_URL set            → not bundled; you plug your own transport
   3. neither                 → development mode: the code is logged to the
                                server console and returned to the client,
                                clearly marked as a dev code.

   Swap in Postmark / SES / SendGrid by editing sendMail() — it only needs
   to return { delivered: boolean, transport }.
   ============================================================ */

const FROM = process.env.MAIL_FROM || 'Volyx <no-reply@volyx.local>';

export function mailMode() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_URL) return 'smtp';
  return 'dev';
}

export function devCodeAllowed() {
  return mailMode() === 'dev';
}

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

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f4;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;border:1px solid #dde5e1;overflow:hidden">
    <div style="background:#0d3b2e;padding:20px 24px;color:#fff">
      <div style="font-size:20px;font-weight:700;letter-spacing:.02em">Volyx</div>
      <div style="font-size:12px;color:#e8c37a;letter-spacing:.12em;text-transform:uppercase;margin-top:2px">
        Marks in. Report cards out.
      </div>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 14px;color:#46554f;font-size:14px">Use this code to ${action}:</p>
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:.32em;color:#12503d;background:#e6f1ec;border-radius:10px;padding:16px;text-align:center">${code}</div>
      <p style="margin:18px 0 0;color:#6c7b74;font-size:13px">It expires in ${minutes} minutes and can only be used once.</p>
    </div>
  </div>
</div>`;

  return { subject: `${code} is your Volyx code`, text, html };
}

export async function sendMail({ to, subject, text, html }) {
  const mode = mailMode();

  if (mode === 'resend') {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error('[mail] Resend rejected the message:', res.status, body);
        return { delivered: false, transport: 'resend' };
      }
      return { delivered: true, transport: 'resend' };
    } catch (err) {
      console.error('[mail] Resend request failed:', err.message);
      return { delivered: false, transport: 'resend' };
    }
  }

  if (mode === 'smtp') {
    console.warn('[mail] SMTP_URL is set but no SMTP transport is bundled — falling back to logging.');
  }

  console.log(`\n[mail:dev] to=${to}\n[mail:dev] subject=${subject}\n[mail:dev] ${text.split('\n')[0]}\n`);
  return { delivered: false, transport: 'dev' };
}

export async function sendVerificationCode({ to, code, purpose, schoolName }) {
  const t = template({ code, purpose, schoolName, minutes: 15 });
  const result = await sendMail({ to, ...t });
  return result;
}

/* Student login details. Unlike a verification code this carries a real
   password, so it is sent to the address the guardian chose — never to the
   student's login address itself. */
function credentialsTemplate({ studentName, loginEmail, password, schoolName, signInUrl, guardianName, days }) {
  const subject = `${schoolName} · ${studentName}'s Volyx login`;
  const text = [
    `Hello ${studentName},`,
    '',
    `${guardianName || 'Your guardian'} created a Volyx account for your school results.`,
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
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1b1b1f;line-height:1.55">
    <p>Hello ${escapeHtml(studentName)},</p>
    <p>${escapeHtml(guardianName || 'Your guardian')} created a Volyx account for your school results.</p>
    <table style="border-collapse:collapse;margin:18px 0">
      <tr><td style="padding:6px 16px 6px 0;color:#6b6b75">Sign-in address</td><td style="font-weight:600">${escapeHtml(loginEmail)}</td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#6b6b75">Temporary password</td><td style="font-family:ui-monospace,monospace;font-weight:600">${escapeHtml(password)}</td></tr>
    </table>
    <p><a href="${escapeHtml(signInUrl)}" style="background:#12203a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open Volyx</a></p>
    <p style="color:#6b6b75;font-size:13px">You'll be asked to choose your own password. This temporary password expires in ${days} days.</p>
  </div>`;

  return { subject, text, html };
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function sendStudentCredentials({ to, studentName, loginEmail, password, schoolName, signInUrl, guardianName, days = 30 }) {
  return sendMail({ to, ...credentialsTemplate({ studentName, loginEmail, password, schoolName, signInUrl, guardianName, days }) });
}
