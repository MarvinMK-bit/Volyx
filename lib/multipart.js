/* Minimal multipart/form-data parser (no dependencies).
   Enough for browser file uploads: text fields + file parts. */

export function getBoundary(contentType = '') {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  return (m[1] || m[2] || '').trim();
}

export function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = [];
  if (!boundary) return { fields, files };

  const delim = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(delim);

  while (cursor !== -1) {
    let start = cursor + delim.length;

    // final boundary: --boundary--
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;

    // skip CRLF after boundary
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    const next = buffer.indexOf(delim, start);
    if (next === -1) break;

    let end = next;
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;

    const part = buffer.subarray(start, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const rawHeaders = part.subarray(0, headerEnd).toString('utf8');
      const body = part.subarray(headerEnd + 4);
      const disp = /content-disposition:([^\r\n]*)/i.exec(rawHeaders)?.[1] || '';
      const name = /name="([^"]*)"/i.exec(disp)?.[1];
      const filename = /filename="([^"]*)"/i.exec(disp)?.[1];
      const type = /content-type:\s*([^\r\n]*)/i.exec(rawHeaders)?.[1]?.trim();

      if (name) {
        if (filename !== undefined) {
          if (filename.trim()) {
            files.push({ field: name, filename, contentType: type || 'application/octet-stream', data: body });
          }
        } else {
          fields[name] = body.toString('utf8');
        }
      }
    }
    cursor = next;
  }

  return { fields, files };
}
