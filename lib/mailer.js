/* ============================================================
   MAILER (NO OTP / DATABASE ONLY MODE)
   All verification codes and OTP flows have been removed.
   Signups and sign-ins are directly processed by the backend DB.
   ============================================================ */

const FROM = process.env.MAIL_FROM || 'Volyx <no-reply@volyx.local>';

// Common personal email domains used to differentiate org emails
const PERSONAL_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com'];

export function mailMode() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_URL) return 'smtp';
  return 'dev';
}

/* ============================================================
   EMAIL VALIDATION & ROUTING LOGIC
   ============================================================ */

/**
 * Validates standard email addresses (e.g., name@gmail.com).
 */
export function isValidSignupEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim().toLowerCase());
}

/**
 * Helper to check if an email belongs to a custom organization domain.
 */
export function isOrgEmail(email) {
  if (!isValidSignupEmail(email)) return false;
  const domain = email.split('@')[1].toLowerCase();
  return !PERSONAL_DOMAINS.includes(domain);
}

/* ============================================================
   BASE MAIL TRANSPORT
   ============================================================ */

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

/* ============================================================
   NON-OTP NOTIFICATIONS
   ============================================================ */

/* Student login details dispatch (No OTP involved) */
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