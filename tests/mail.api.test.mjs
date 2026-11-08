/* ============================================================
   EMAIL DELIVERY — verification codes must actually arrive.
   Spins a real (fake) SMTP server, points a real Volyx instance at it,
   and proves the code inside the email is the code that signs you in.

   Self-contained: starts and stops its own servers.
     node mail.api.test.mjs
   ============================================================ */

import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = (() => {
  for (const c of [process.env.VOLYX_ROOT, path.resolve(HERE, '..'), path.resolve(HERE, '..', 'gradescript-portal')]) {
    if (c && fs.existsSync(path.join(c, 'server.js'))) return c;
  }
  return path.resolve(HERE, '..');
})();

let fails = 0;
const check = (l, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ' — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- a mailbox that accepts mail and remembers it ---------- */

function startSmtp(port = 0) {
  const inbox = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    let rcpt = [];
    let authStep = 0; // 0 = none, 1 = expect username, 2 = expect password
    socket.write('220 volyx-test ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            inbox.push({ to: rcpt, raw: data });
            data = '';
            rcpt = [];
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            data += `${line}\r\n`;
          }
          continue;
        }

        // AUTH LOGIN sends its username and password as bare base64 lines, so
        // they are consumed by state — never by pattern matching, which would
        // also swallow verbs like DATA.
        if (authStep === 1) {
          authStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authStep === 2) {
          authStep = 0;
          socket.write('235 2.7.0 Authentication successful\r\n');
          continue;
        }

        const upper = line.trim().toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-volyx-test\r\n250-8BITMIME\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 20000000\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          const m = /<([^>]+)>/.exec(line);
          if (m) rcpt.push(m[1]);
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'RSET') {
          socket.write('250 Ok\r\n');
        } else if (upper === 'NOOP') {
          socket.write('250 Ok\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 Ok\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, inbox }));
  });
}

/** Pull the 6-digit code out of a captured message (text or quoted-printable). */
function codeFromMessage(raw) {
  const unfolded = raw.replace(/=\r\n/g, '').replace(/=3D/g, '=');
  const m = /\b(\d{6})\b/.exec(unfolded);
  return m ? m[1] : null;
}

/* ---------- a Volyx instance pointed at that mailbox ---------- */

async function startApp(env, port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-mail-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port), HOST: '127.0.0.1', VOLYX_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  for (let i = 0; i < 80; i += 1) {
    await sleep(150);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, dataDir, log: () => log };
    } catch { /* not up yet */ }
  }
  throw new Error(`server did not start on ${port}:\n${log}`);
}

const stop = (child) => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 3000); });

const j = async (base, p, { method = 'GET', body, token } = {}) => {
  const headers = {};
  if (token) headers['X-Session'] = token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
};

/* ---------- 1. with a working mail server ---------- */
const smtp = await startSmtp(0);
const BASE = 'http://127.0.0.1:3210';
const app = await startApp({
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtp.port),
  SMTP_SECURE: 'false',
  SMTP_USER: 'volyx@school.test',
  SMTP_PASS: 'app-password',
  MAIL_FROM: 'Volyx <volyx@school.test>',
}, 3210);

try {
  const cfg = await j(BASE, '/api/config');
  check('the app reports real email (not dev mode)', cfg.body.mailMode === 'smtp', cfg.body.mailMode);
  check('on-screen codes are switched off once mail is configured', cfg.body.devCodes === false);
  check('the sender address is exposed for the UI', /volyx@school\.test/.test(cfg.body.mailFrom || ''), cfg.body.mailFrom);

  const email = `code.${Date.now()}@school.test`;
  const signup = await j(BASE, '/api/auth/signup', { method: 'POST', body: { name: 'Code Tester', email, password: 'passw0rd1', accountType: 'teacher' } });
  check('signup succeeds', signup.status === 200);
  check('signup reports the email as delivered', signup.body.delivery?.delivered === true, JSON.stringify(signup.body.delivery));
  check('the code is NOT returned to the browser', signup.body.delivery?.devCode === undefined);
  check('the message tells the user to check the inbox', /emailed a 6-digit code/i.test(signup.body.message || ''), signup.body.message);

  await sleep(300);
  check('the mail server received a message', smtp.inbox.length >= 1, String(smtp.inbox.length));
  const mail = smtp.inbox[smtp.inbox.length - 1];
  check('it was addressed to the new account', (mail.to || []).some((x) => x.includes(email)), (mail.to || []).join(','));
  check('the subject carries the code', /is your Volyx code/i.test(mail.raw));
  const code = codeFromMessage(mail.raw);
  check('the email contains a 6-digit code', /^\d{6}$/.test(code || ''), String(code));

  const verified = await j(BASE, '/api/auth/verify-email', { method: 'POST', body: { email, code } });
  check('the emailed code activates the account', verified.status === 200 && verified.body.user?.emailVerified === true, JSON.stringify(verified.body).slice(0, 90));
  const token = verified.body.token;

  const codeAgain = await j(BASE, '/api/auth/request-code', { method: 'POST', body: { email } });
  check('"email me a code" also delivers', codeAgain.body.delivery?.delivered === true);
  check('that response hides the code too', codeAgain.body.delivery?.devCode === undefined);
  await sleep(250);
  const second = codeFromMessage(smtp.inbox[smtp.inbox.length - 1].raw);
  const codeLogin = await j(BASE, '/api/auth/verify-code', { method: 'POST', body: { email, code: second } });
  check('the newly emailed code signs you in', codeLogin.status === 200 && Boolean(codeLogin.body.token));

  /* admin tooling */
  const admin = await j(BASE, '/api/auth/login', { method: 'POST', body: { email: 'ryanroject@gmail.com', password: 'volyx-admin-2026' } });
  const ADT = admin.body.token;
  check('the admin can sign in', Boolean(ADT));

  const mailStatus = await j(BASE, '/api/admin/mail', { token: ADT });
  check('the admin sees the mail transport', mailStatus.body.mode === 'smtp', mailStatus.body.mode);
  check('the admin sees the mailbox is reachable', mailStatus.body.check?.ok === true, JSON.stringify(mailStatus.body.check));

  const before = smtp.inbox.length;
  const test = await j(BASE, '/api/admin/mail/test', { method: 'POST', token: ADT, body: { to: 'ryanroject@gmail.com' } });
  check('an admin can send a test email', test.status === 200 && test.body.delivered === true, JSON.stringify(test.body).slice(0, 90));
  await sleep(300);
  check('the test email actually arrived', smtp.inbox.length === before + 1);
  check('the test email is addressed to the admin', /ryanroject@gmail\.com/.test(smtp.inbox[smtp.inbox.length - 1].raw));

  const audit = await j(BASE, '/api/admin/audit?action=platform.mail.test', { token: ADT });
  check('test emails are recorded in the audit log', audit.body.total >= 1, String(audit.body.total));

  const teacherTry = await j(BASE, '/api/admin/mail/test', { method: 'POST', token, body: { to: 'x@school.test' } });
  check('a teacher cannot send admin test email', teacherTry.status === 403, String(teacherTry.status));
} finally {
  await stop(app.child);
  smtp.server.close();
}

/* ---------- 2. with a broken mail server: fail loudly, never fall back to on-screen ---------- */
const BASE2 = 'http://127.0.0.1:3211';
const broken = await startApp({
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1',            // nothing listens here: connection refused
  SMTP_SECURE: 'false',
  SMTP_USER: 'volyx@school.test',
  SMTP_PASS: 'app-password',
}, 3211);

try {
  const cfg = await j(BASE2, '/api/config');
  check('a broken mailbox is still "configured"', cfg.body.mailMode === 'smtp', cfg.body.mailMode);

  const email = `broken.${Date.now()}@school.test`;
  const signup = await j(BASE2, '/api/auth/signup', { method: 'POST', body: { name: 'Broken Mailer', email, password: 'passw0rd1', accountType: 'teacher' } });
  check('signup still returns a usable response', signup.status === 200);
  check('the failure is reported, not hidden', signup.body.delivery?.delivered === false);
  check('the code is never shown on screen as a fallback', signup.body.delivery?.devCode === undefined);
  check('the user is told the email could not be sent', /could not send the email/i.test(signup.body.message || ''), signup.body.message);
  check('the error explains what to fix', Boolean(signup.body.delivery?.error), signup.body.delivery?.error);
} finally {
  await stop(broken.child);
}

/* ---------- 3. no configuration at all keeps the documented dev behaviour ---------- */
const BASE3 = 'http://127.0.0.1:3212';
const dev = await startApp({}, 3212);
try {
  const cfg = await j(BASE3, '/api/config');
  check('with nothing configured the app says so', cfg.body.mailMode === 'dev', cfg.body.mailMode);
  check('dev mode still shows codes on screen', cfg.body.devCodes === true);
  const email = `dev.${Date.now()}☺@school.test`.replace('☺', '');
  const signup = await j(BASE3, '/api/auth/signup', { method: 'POST', body: { name: 'Dev Mode', email, password: 'passw0rd1', accountType: 'teacher' } });
  check('dev mode returns the code so local testing still works', /^\d{6}$/.test(signup.body.delivery?.devCode || ''));
} finally {
  await stop(dev.child);
}

console.log('');
console.log(fails === 0 ? 'ALL EMAIL DELIVERY CHECKS PASSED' : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
