/**
 * Upload route mechanics — multer parsing, the type allow-list, magic-byte
 * sniffing, the disk write, and the returned URL.
 *
 * Auth is applied where the router is mounted (see index.ts), not inside it, so
 * the router can be exercised directly here without a token or a database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';
import uploadRoutes from './uploadRoutes';

/** Valid PNG signature + enough bytes for sniffMedia's 12-byte minimum. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

/** Passes the .png allow-list but the bytes are not an image. */
const NOT_AN_IMAGE = Buffer.from('this is plain text, definitely not a PNG file at all', 'utf8');

let server: Server;
let base: string;
/** Files written during the test, cleaned up afterwards. */
const written: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use('/upload', uploadRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const f of written) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** POSTs one file as multipart/form-data, the way the client's uploadFile does. */
async function post(filename: string, bytes: Buffer, type: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
  const res = await fetch(`${base}/upload`, { method: 'POST', body: form });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Absolute path the route writes to, derived the same way the route does. */
const uploadDir = path.join(__dirname, '../../../uploads');

describe('POST /upload — disk backend', () => {
  it('accepts a PNG, writes it to the uploads dir, and returns its URL', async () => {
    const { status, body } = await post('photo.png', PNG, 'image/png');
    expect(status).toBe(200);
    expect(body.url).toMatch(/^\/uploads\/\d+-\d+\.png$/);

    const onDisk = path.join(uploadDir, path.basename(body.url));
    written.push(onDisk);
    expect(fs.existsSync(onDisk)).toBe(true);
    // Round-trips byte-for-byte.
    expect(fs.readFileSync(onDisk).equals(PNG)).toBe(true);
  });

  it('gives each upload a distinct name rather than overwriting', async () => {
    const a = await post('same.png', PNG, 'image/png');
    const b = await post('same.png', PNG, 'image/png');
    expect(a.body.url).not.toBe(b.body.url);
    written.push(
      path.join(uploadDir, path.basename(a.body.url)),
      path.join(uploadDir, path.basename(b.body.url)),
    );
  });

  it('rejects a disallowed type with 400, not 500', async () => {
    const { status, body } = await post('notes.txt', PNG, 'text/plain');
    expect(status).toBe(400);
    expect(body.message).toMatch(/unsupported file type/i);
  });

  it('rejects an allow-listed extension whose bytes are not media, and leaves nothing behind', async () => {
    const before = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0;
    const { status, body } = await post('fake.png', NOT_AN_IMAGE, 'image/png');
    expect(status).toBe(400);
    expect(body.message).toMatch(/do not match a supported/i);
    // The route deletes the file it had already written.
    const after = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0;
    expect(after).toBe(before);
  });

  it('rejects a request with no file attached', async () => {
    const res = await fetch(`${base}/upload`, { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toMatch(/no file uploaded/i);
  });

  it('rejects an SVG, which is deliberately not allow-listed', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
    const { status } = await post('icon.svg', svg, 'image/svg+xml');
    expect(status).toBe(400);
  });
});
