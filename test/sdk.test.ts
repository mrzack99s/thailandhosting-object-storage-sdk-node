// Tests against an in-memory fake of the /v1 API, and (when
// TH_OBJECT_STORAGE_ENDPOINT is set) a round trip against a real endpoint.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client, IntegrityError, NotFoundError } from '../src/index.ts';

const MiB = 1024 * 1024;
const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');

class Fake {
  objects = new Map<string, Buffer>();
  types = new Map<string, string>();
  uploads = new Map<string, Map<number, Buffer>>();
  flaky = 0;
  corrupt = false;
  inflight = 0;
  maxInflight = 0;
  requests = 0;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}

function send(res: ServerResponse, status: number, doc: unknown) {
  const data = Buffer.from(JSON.stringify(doc));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length }).end(data);
}
const fail = (res: ServerResponse, status: number, code: string) => send(res, status, { error: { code, message: code } });
const b64 = (s: string) => Buffer.from(s).toString('base64url');

function startFake(fake: Fake): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    fake.requests++;
    fake.maxInflight = Math.max(fake.maxInflight, ++fake.inflight);
    res.on('close', () => fake.inflight--);
    let body = await readBody(req);
    if (req.headers.authorization !== 'Bearer KEY:SECRET') return fail(res, 401, 'unauthorized');
    if (fake.flaky > 0) {
      fake.flaky--;
      return fail(res, 503, 'busy');
    }
    await new Promise((r) => setTimeout(r, 3));
    if (fake.corrupt && body.length && req.method === 'PUT') body = Buffer.concat([Buffer.from([body[0]! ^ 1]), body.subarray(1)]);
    const u = new URL(req.url!, 'http://x');
    // /v1/buckets/{bucket}/{kind}/{rest...}
    const p = u.pathname.slice('/v1/buckets/'.length);
    const [bucket = '', kind = '', ...restParts] = p.split('/');
    const rest = restParts.join('/');
    if (kind === 'objects' && rest) {
      const key = decodeURIComponent(rest);
      const id = `${bucket}/${key}`;
      if (req.method === 'PUT') {
        fake.objects.set(id, body);
        fake.types.set(id, String(req.headers['content-type'] ?? ''));
        return send(res, 200, { key, size: body.length, etag: md5(body) });
      }
      if (req.method === 'DELETE') {
        fake.objects.delete(id);
        return res.writeHead(204).end();
      }
      const data = fake.objects.get(id);
      if (!data) return fail(res, 404, 'object_not_found');
      const etag = `"${md5(data)}"`;
      if (req.headers['if-match'] && req.headers['if-match'] !== etag) return fail(res, 412, 'precondition_failed');
      let start = 0, end = data.length - 1, status = 200;
      const headers: Record<string, string | number> = { ETag: etag, 'Content-Type': fake.types.get(id) ?? '' };
      const range = req.headers.range;
      if (range) {
        const [a, b] = range.slice(6).split('-');
        start = Number(a);
        if (b) end = Math.min(Number(b), data.length - 1);
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      return res.end(req.method === 'GET' ? data.subarray(start, end + 1) : undefined);
    }
    if (kind === 'objects') {
      const limit = Number(u.searchParams.get('limit') ?? 1000);
      const after = u.searchParams.get('cursor') ? Buffer.from(u.searchParams.get('cursor')!, 'base64url').toString() : '';
      const prefix = u.searchParams.get('prefix') ?? '';
      let keys = [...fake.objects.keys()].filter((k) => k.startsWith(bucket + '/')).map((k) => k.slice(bucket!.length + 1))
        .filter((k) => k.startsWith(prefix) && k > after).sort();
      const out: any = { folders: [] };
      if (keys.length > limit) {
        keys = keys.slice(0, limit);
        out.nextCursor = b64(keys[limit - 1]!);
      }
      out.objects = keys.map((k) => ({ key: k, size: fake.objects.get(`${bucket}/${k}`)!.length }));
      return send(res, 200, out);
    }
    if (kind === 'uploads') {
      if (!rest) {
        const { key } = JSON.parse(body.toString());
        const id = `${b64(key)}.${fake.requests}`;
        fake.uploads.set(id, new Map());
        return send(res, 201, { uploadId: id, key });
      }
      const [id, ...subParts] = rest.split('/');
      const sub = subParts.join('/');
      const up = fake.uploads.get(id!);
      if (!up) return fail(res, 404, 'upload_not_found');
      const key = Buffer.from(id!.split('.')[0]!, 'base64url').toString();
      if (sub.startsWith('parts/')) {
        const n = Number(sub.slice(6));
        up.set(n, body);
        return send(res, 200, { number: n, etag: md5(body), size: body.length });
      }
      if (sub === 'complete') {
        const parsed = body.length ? JSON.parse(body.toString()) : {};
        const want: { number: number }[] = parsed.parts ?? [...up.keys()].sort((a, b) => a - b).map((number) => ({ number }));
        const data = Buffer.concat(want.map((p) => up.get(p.number)!));
        fake.objects.set(`${bucket}/${key}`, data);
        fake.uploads.delete(id!);
        return send(res, 200, { key, size: data.length, etag: `x-${want.length}` });
      }
      if (req.method === 'DELETE') {
        fake.uploads.delete(id!);
        return res.writeHead(204).end();
      }
    }
    fail(res, 404, 'not_found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${addr.port}` });
  }));
}

describe('against a fake service', () => {
  let fake: Fake;
  let server: Server;
  let client: Client;
  let dir: string;
  before(async () => {
    fake = new Fake();
    const s = await startFake(fake);
    server = s.server;
    client = new Client({ endpoint: s.url, accessKeyId: 'KEY', secretAccessKey: 'SECRET', partSize: 5 * MiB, concurrency: 4 });
    dir = await mkdtemp(join(tmpdir(), 'th-sdk-'));
  });
  after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('put, get and key escaping', async () => {
    const b = client.bucket('b');
    const key = 'รูป/a b+c?#%.txt';
    await b.put(key, 'hello');
    assert.ok(fake.objects.has('b/' + key));
    assert.equal(fake.types.get('b/' + key), 'text/plain');
    assert.equal(await b.getText(key), 'hello');
    await assert.rejects(b.getBytes('missing'), (e: any) => e instanceof NotFoundError && e.code === 'object_not_found');
    assert.equal(await b.exists('missing'), false);
  });

  test('retries busy answers', async () => {
    fake.flaky = 2;
    await client.bucket('b').put('k', 'data');
    assert.equal(fake.objects.get('b/k')!.toString(), 'data');
  });

  test('refuses damaged uploads and aborts them', async () => {
    const b = client.bucket('b');
    fake.corrupt = true;
    try {
      await assert.rejects(b.put('k', 'data'), IntegrityError);
      await assert.rejects(b.upload('big', Readable.from([randomBytes(6 * MiB)])), IntegrityError);
      assert.equal(fake.uploads.size, 0);
    } finally {
      fake.corrupt = false;
    }
  });

  test('uploadFile sends parts in parallel; downloadFile fetches ranges in parallel', async () => {
    const b = client.bucket('b');
    const data = randomBytes(3 * 5 * MiB + 77);
    const src = join(dir, 'src.bin');
    await writeFile(src, data);
    fake.flaky = 3;
    fake.maxInflight = 0;
    await b.uploadFile('file.bin', src);
    assert.ok(fake.objects.get('b/file.bin')!.equals(data));
    assert.ok(fake.maxInflight >= 2, 'parts were not sent in parallel');
    fake.maxInflight = 0;
    const dst = join(dir, 'out', 'dst.bin');
    await b.downloadFile('file.bin', dst);
    assert.ok((await readFile(dst)).equals(data));
    assert.ok(fake.maxInflight >= 2, 'ranges were not fetched in parallel');
    await assert.rejects(access(dst + '.download'));
  });

  test('upload streams of unknown length', async () => {
    const b = client.bucket('b');
    const data = randomBytes(5 * 5 * MiB + 1);
    // Odd-sized chunks, as a socket would deliver them.
    const chunks = [] as Buffer[];
    for (let i = 0; i < data.length; i += 777_777) chunks.push(data.subarray(i, i + 777_777));
    await b.upload('s.bin', Readable.from(chunks));
    assert.ok(fake.objects.get('b/s.bin')!.equals(data));
    fake.requests = 0;
    await b.upload('small.bin', Readable.from([Buffer.from('tiny')]));
    assert.equal(fake.requests, 1, 'a small stream should be one request');
  });

  test('objects() pages through a listing', async () => {
    for (let i = 0; i < 25; i++) fake.objects.set(`b/p/${String(i).padStart(2, '0')}`, Buffer.from('x'));
    const keys: string[] = [];
    for await (const o of client.bucket('b').objects('p/', { pageSize: 10 })) keys.push(o.key);
    assert.deepEqual(keys, Array.from({ length: 25 }, (_, i) => `p/${String(i).padStart(2, '0')}`));
  });

  test('range downloads', async () => {
    const b = client.bucket('b');
    await b.put('r', new Uint8Array(Array.from({ length: 100 }, (_, i) => i)));
    const dl = await b.get('r', { offset: 10, length: 5 });
    const got = Buffer.from(await new Response(dl.body).arrayBuffer());
    assert.deepEqual([...got], [10, 11, 12, 13, 14]);
    assert.equal(dl.info.size, 100);
  });
});

const endpoint = process.env.TH_OBJECT_STORAGE_ENDPOINT;
describe('against a real endpoint', { skip: !endpoint && 'TH_OBJECT_STORAGE_ENDPOINT is not set' }, () => {
  test('round trip', async () => {
    const client = new Client({ endpoint: endpoint!, accessKeyId: process.env.TH_ACCESS_KEY_ID!, secretAccessKey: process.env.TH_SECRET_ACCESS_KEY! });
    const name = 'sdk-node-it-' + Date.now().toString(36);
    await client.createBucket(name);
    const b = client.bucket(name);
    const dir = await mkdtemp(join(tmpdir(), 'th-sdk-it-'));
    try {
      const data = randomBytes(40 * MiB);
      await writeFile(join(dir, 'src.bin'), data);
      let t = Date.now();
      const info = await b.uploadFile('big/file.bin', join(dir, 'src.bin'), { metadata: { origin: 'node-sdk' } });
      console.log(`uploaded ${info.size / MiB} MiB in ${Date.now() - t} ms`);
      t = Date.now();
      await b.downloadFile('big/file.bin', join(dir, 'dst.bin'));
      console.log(`downloaded in ${Date.now() - t} ms`);
      assert.ok((await readFile(join(dir, 'dst.bin'))).equals(data));
      assert.equal((await b.head('big/file.bin')).metadata.origin, 'node-sdk');
      await b.put('notes/ไทย.txt', 'สวัสดี');
      assert.equal((await b.list({ delimiter: '/' })).folders.length, 2);
      await b.copy('notes/ไทย.txt', 'notes/copy.txt');
      const link = await b.createLink('notes/ไทย.txt', { expiresIn: 60 });
      assert.equal(await (await fetch(link.url)).text(), 'สวัสดี');
    } finally {
      const keys: string[] = [];
      for await (const o of b.objects()) keys.push(o.key);
      await b.deleteMany(keys);
      await client.deleteBucket(name);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
