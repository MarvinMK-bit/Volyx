/* ============================================================
   PAGE STORE
   GradeScriptUG returns annotations, never the files you sent:
   "your frontend draws on its own copy of each page". So we keep
   that copy — one folder per grading, inside data/uploads.

   Only the script pages a marking refers to are kept; marking
   guides are not stored.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', 'data', 'uploads');

const EXT_FOR = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

const MIME_FOR = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
const dirFor = (gradingId) => path.join(ROOT, safeId(gradingId));

/**
 * Writes the SCRIPT files of one upload to disk.
 * @returns {Array<{index,file,contentType,filename,kind}>}
 */
export function savePages(gradingId, attachments = []) {
  const id = safeId(gradingId);
  if (!id) return [];
  let dir;
  try {
    dir = dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[storage] could not create page folder:', err.message);
    return [];
  }

  const pages = [];
  attachments.forEach((a, i) => {
    if (!a?.data?.length) return;
    const ext = EXT_FOR[a.contentType] || path.extname(a.filename || '').toLowerCase() || '.bin';
    const file = `p${i + 1}${ext}`;
    try {
      fs.writeFileSync(path.join(dir, file), a.data);
      pages.push({
        index: i + 1,
        file,
        contentType: a.contentType || MIME_FOR[ext] || 'application/octet-stream',
        filename: a.filename || file,
        kind: ext === '.pdf' ? 'pdf' : 'image',
      });
    } catch (err) {
      console.error('[storage] could not save page:', err.message);
    }
  });
  return pages;
}

/** Absolute path for a stored page, or null when it is not ours. */
export function pagePath(gradingId, index) {
  const id = safeId(gradingId);
  const n = Number(index);
  if (!id || !Number.isInteger(n) || n < 1 || n > 200) return null;
  const dir = dirFor(id);
  if (!fs.existsSync(dir)) return null;
  const hit = fs
    .readdirSync(dir)
    .find((f) => f.startsWith(`p${n}.`));
  return hit ? path.join(dir, hit) : null;
}

export function contentTypeFor(filePath) {
  return MIME_FOR[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function removePages(gradingId) {
  const id = safeId(gradingId);
  if (!id) return;
  try {
    fs.rmSync(dirFor(id), { recursive: true, force: true });
  } catch (err) {
    console.error('[storage] could not remove pages:', err.message);
  }
}

export function storageRoot() {
  return ROOT;
}
