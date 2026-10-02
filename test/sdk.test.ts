// Tests against an in-memory fake of the /v1 API, and (when
// TH_OBJECT_STORAGE_ENDPOINT is set) a round trip against a real endpoint.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  Client, IntegrityError, NotFoundError, NotModifiedError, ObjectStorageError, PreconditionFailedError, contentDigest, signRequest,
} from '../src/index.ts';
import { signatureBase, signatureParams } from '../src/signing.ts';

const MiB = 1024 * 1024;
const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');

class Fake {
  objects = new Map<string, Buffer>();
  types = new Map<string, string>();
  digests = new Map<string, string>(); // Repr-Digest of objects put in one request
  times = new Map<string, Date>();
  uploads = new Map<string, Map<number, Buffer>>();
  flaky = 0;
  retryAfter = ''; // sent with the flaky 503s when set
  corrupt = false; // damage what is stored (after the digest check)
  tamper = false; // damage the body in transit (before the digest check)
  inflight = 0;
  maxInflight = 0;
  requests = 0;
  headerValues: string[] = []; // every request header value seen
  signatures: string[] = [];
  bodyDigests: { method: string; path: string; digest?: string }[] = [];
  public = new Map<string, { prefix: string; list?: boolean }[]>(); // bucket: what anyone may read
}

/** An unsigned GET or HEAD of an object a bucket made public. */
function publicRead(fake: Fake, req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const [bucket = '', kind = '', ...rest] = new URL(req.url!, 'http://x').pathname.slice('/v1/buckets/'.length).split('/');
  if (kind !== 'objects' || !rest.length) return false;
  const key = decodeURIComponent(rest.join('/'));
  return (fake.public.get(bucket) ?? []).some((r) => key.startsWith(r.prefix));
}

/** Checks an RFC 9421 signature the way the service does: rebuild the base from the request as
 *  received, HMAC it with the key's secret, compare. Returns why it is not valid, or ''. */
function checkSignature(req: IncomingMessage, body: Buffer): string {
  const input = String(req.headers['signature-input'] ?? '');
  const m = /^th=\(([^)]*)\)(;.*)$/.exec(input);
  const sig = /^th=:([A-Za-z0-9+/=]+):$/.exec(String(req.headers.signature ?? ''));
  if (!m || !sig) return 'malformed';
  const components = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  const created = Number(/;created=(\d+)/.exec(m[2]!)?.[1]);
  if (/;keyid="([^"]*)"/.exec(m[2]!)?.[1] !== 'KEY') return 'unknown key';
  if (/;alg="([^"]*)"/.exec(m[2]!)?.[1] !== 'hmac-sha256') return 'bad alg';
  if (!(Math.abs(Date.now() / 1000 - created) <= 300)) return 'clock skew';
  for (const need of ['@method', '@authority', '@path', '@query']) if (!components.includes(need)) return 'must cover ' + need;
  if (body.length && !components.includes('content-digest')) return 'body not covered';
  const [path = '', query = ''] = req.url!.split(/\?(.*)/s);
  const value = (c: string) => {
    switch (c) {
      case '@method': return req.method!;
      case '@authority': return String(req.headers.host).toLowerCase().replace(/:(443|80)$/, '');
      case '@path': return path || '/';
      case '@query': return '?' + query;
    }
    return req.headers[c] === undefined ? undefined : String(req.headers[c]).trim();
  };
  const lines: string[] = [];
  for (const c of components) {
    const v = value(c);
    if (v === undefined) return 'missing ' + c;
    lines.push(`"${c}": ${v}`);
  }
  lines.push(`"@signature-params": ${input.slice(3)}`);
  const want = createHmac('sha256', 'SECRET').update(lines.join('\n')).digest();
  const got = Buffer.from(sig[1]!, 'base64');
  return got.length === want.length && timingSafeEqual(got, want) ? '' : 'mismatch';
}

/** If-Match / If-None-Match against an object's state, as the service checks writes. */
function condOK(req: IncomingMessage, exists: boolean, etag: string): boolean {
  const list = (v: string) => v.split(',').map((e) => e.trim().replace(/^W\//, '').replace(/"/g, ''));
  const im = req.headers['if-match'];
  if (im && (!exists || !(im === '*' || list(im).includes(etag)))) return false;
  const inm = req.headers['if-none-match'];
  if (inm && exists && (inm === '*' || list(inm).includes(etag))) return false;
  return true;
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
const titles: Record<string, string> = { object_not_found: 'The object does not exist.', precondition_failed: 'The object is not in the state If-Match / If-None-Match asked for.' };
/** A Problem Details (RFC 9457) answer; HEAD gets only the X-Error-Code header. */
function fail(req: IncomingMessage, res: ServerResponse, status: number, code: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string | number> = { 'X-Error-Code': code, ...extra };
  if (status === 401) headers['Accept-Signature'] = 'th=("@method" "@authority" "@path" "@query" "content-digest");alg="hmac-sha256"';
  if (req.method === 'HEAD') return res.writeHead(status, headers).end();
  const data = Buffer.from(JSON.stringify({
    type: 'tag:thailandhosting.com,2026:object-storage/' + code, title: titles[code] ?? `Problem: ${code}.`, status, code, instance: req.url!.split('?')[0],
  }));
  res.writeHead(status, { ...headers, 'Content-Type': 'application/problem+json', 'Content-Length': data.length }).end(data);
}
const b64 = (s: string) => Buffer.from(s).toString('base64url');

function startFake(fake: Fake): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    fake.requests++;
    fake.maxInflight = Math.max(fake.maxInflight, ++fake.inflight);
    res.on('close', () => fake.inflight--);
    for (const v of Object.values(req.headers)) fake.headerValues.push(String(v));
    let body = await readBody(req);
    if (fake.tamper && body.length) body = Buffer.concat([Buffer.from([body[0]! ^ 1]), body.subarray(1)]);
    if (req.headers['signature-input']) {
      fake.signatures.push(String(req.headers.signature));
      if (checkSignature(req, body)) return fail(req, res, 401, 'invalid_signature');
    } else if (!publicRead(fake, req)) {
      return fail(req, res, 401, 'unauthorized');
    }
    const cd = req.headers['content-digest'] as string | undefined;
    if (body.length || cd) fake.bodyDigests.push({ method: req.method!, path: req.url!, digest: cd });
    if (cd && cd !== `sha-256=:${sha256(body)}:`) return fail(req, res, 400, 'bad_digest');
    if (fake.flaky > 0) {
      fake.flaky--;
      return fail(req, res, 503, 'busy', fake.retryAfter ? { 'Retry-After': fake.retryAfter } : {});
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
      const current = fake.objects.get(id);
      if (req.method === 'PUT' || req.method === 'DELETE') {
        if (!condOK(req, !!current, current ? md5(current) : '')) return fail(req, res, 412, 'precondition_failed');
      }
      if (req.method === 'PUT') {
        fake.objects.set(id, body);
        fake.types.set(id, String(req.headers['content-type'] ?? ''));
        fake.times.set(id, new Date(Math.floor(Date.now() / 1000) * 1000));
        if (cd) fake.digests.set(id, cd);
        else fake.digests.delete(id);
        return send(res, 200, { key, size: body.length, etag: md5(body) });
      }
      if (req.method === 'DELETE') {
        fake.objects.delete(id);
        fake.digests.delete(id);
        return res.writeHead(204).end();
      }
      const data = current;
      if (!data) return fail(req, res, 404, 'object_not_found');
      const etag = `"${md5(data)}"`;
      const modified = fake.times.get(id) ?? new Date(0);
      const headers: Record<string, string | number> = { ETag: etag, 'Last-Modified': modified.toUTCString(), 'Content-Type': fake.types.get(id) ?? '' };
      if (fake.digests.has(id)) headers['Repr-Digest'] = fake.digests.get(id)!;
      const ims = req.headers['if-modified-since'];
      if (req.headers['if-match'] && !condOK(req, true, md5(data))) return fail(req, res, 412, 'precondition_failed');
      if (req.headers['if-none-match'] ? !condOK(req, true, md5(data)) : ims && modified <= new Date(ims)) {
        return res.writeHead(304, headers).end();
      }
      let start = 0, end = data.length - 1, status = 200;
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
    if (kind === 'public') {
      if (req.method === 'PUT') fake.public.set(bucket, JSON.parse(body.toString()).rules);
      return send(res, 200, { rules: fake.public.get(bucket) ?? [] });
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
      if (!up) return fail(req, res, 404, 'upload_not_found');
      const key = Buffer.from(id!.split('.')[0]!, 'base64url').toString();
      if (sub.startsWith('parts/')) {
        const n = Number(sub.slice(6));
        up.set(n, body);
        return send(res, 200, { number: n, etag: md5(body), size: body.length });
      }
      if (sub === 'complete') {
        const current = fake.objects.get(`${bucket}/${key}`);
        if (!condOK(req, !!current, current ? md5(current) : '')) return fail(req, res, 412, 'precondition_failed');
        const parsed = body.length ? JSON.parse(body.toString()) : {};
        const want: { number: number }[] = parsed.parts ?? [...up.keys()].sort((a, b) => a - b).map((number) => ({ number }));
        const data = Buffer.concat(want.map((p) => up.get(p.number)!));
        fake.objects.set(`${bucket}/${key}`, data);
        fake.digests.delete(`${bucket}/${key}`); // multipart objects have no Repr-Digest
        fake.uploads.delete(id!);
        return send(res, 200, { key, size: data.length, etag: `x-${want.length}` });
      }
      if (req.method === 'DELETE') {
        fake.uploads.delete(id!);
        return res.writeHead(204).end();
      }
    }
    fail(req, res, 404, 'not_found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${addr.port}` });
  }));
}

describe('request signing', () => {
  test('golden signature with a body', () => {
    const url = 'https://objects.th-bkk-1.thailandhosting.com/v1/buckets/photos/objects/a%20b.jpg';
    const digest = 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:';
    const params = '("@method" "@authority" "@path" "@query" "content-digest");created=1767225600;keyid="AKID";alg="hmac-sha256"';
    assert.equal(signatureParams('AKID', 1767225600, true), params);
    assert.equal(signatureBase('PUT', url, params, digest), [
      '"@method": PUT',
      '"@authority": objects.th-bkk-1.thailandhosting.com',
      '"@path": /v1/buckets/photos/objects/a%20b.jpg',
      '"@query": ?',
      '"content-digest": sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
      '"@signature-params": ("@method" "@authority" "@path" "@query" "content-digest");created=1767225600;keyid="AKID";alg="hmac-sha256"',
    ].join('\n'));
    // Computed independently (Python hmac/hashlib) from the base above.
    assert.deepEqual(signRequest({ method: 'put', url, accessKeyId: 'AKID', secretAccessKey: 'SECRET', contentDigest: digest, created: 1767225600 }), {
      'Signature-Input': 'th=' + params,
      Signature: 'th=:4+RX5eGfUEKmFgBZzJIlXsCIW/mtKnZ+3v3GX4r7z7o=:',
    });
  });

  test('golden signature without a body, with a query, default port dropped', () => {
    const url = 'https://Objects.TH-BKK-1.thailandhosting.com:443/v1/buckets/photos/objects?prefix=a%2Fb&limit=10';
    const h = signRequest({ method: 'GET', url, accessKeyId: 'AKID', secretAccessKey: 'SECRET', created: 1767225600 });
    assert.equal(h['Signature-Input'], 'th=("@method" "@authority" "@path" "@query");created=1767225600;keyid="AKID";alg="hmac-sha256"');
    assert.equal(h.Signature, 'th=:QogF7tpNEzBlMIg8uZbtsfu8imaHyA4+0aCxMmYDtM0=:');
  });

  test('content digest', () => {
    assert.equal(contentDigest(Buffer.from('')), 'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:');
    assert.equal(contentDigest(Buffer.from('hello')), 'sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:');
  });
});

describe('against a fake service', () => {
  let fake: Fake;
  let server: Server;
  let url: string;
  let client: Client;
  let dir: string;
  before(async () => {
    fake = new Fake();
    const s = await startFake(fake);
    server = s.server;
    url = s.url;
    client = new Client({ endpoint: url, accessKeyId: 'KEY', secretAccessKey: 'SECRET', partSize: 5 * MiB, concurrency: 4 });
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

  test('signs every request and never sends the secret', async () => {
    fake.headerValues = [];
    const b = client.bucket('b');
    await b.put('sig/x.txt', 'x');
    await b.list({ prefix: 'sig/', limit: 5 });
    await b.head('sig/x.txt');
    assert.ok(fake.headerValues.length > 0);
    assert.ok(!fake.headerValues.some((v) => v.includes('SECRET')), 'the secret was sent');
    assert.ok(!fake.headerValues.some((v) => v.startsWith('Bearer')), 'a Bearer token was sent');
    // A wrong secret is refused, and not retried.
    const wrong = new Client({ endpoint: url, accessKeyId: 'KEY', secretAccessKey: 'WRONG' });
    const n = fake.requests;
    await assert.rejects(wrong.bucket('b').getText('sig/x.txt'), (e: any) => e instanceof ObjectStorageError && e.status === 401 && e.code === 'invalid_signature');
    assert.equal(fake.requests - n, 1);
  });

  test('body digests on single and multipart uploads', async () => {
    const b = client.bucket('b');
    fake.bodyDigests = [];
    await b.put('d/empty', new Uint8Array(0));
    await b.put('d/small', 'hello');
    assert.deepEqual(fake.bodyDigests.map((d) => d.digest), [contentDigest(Buffer.from('')), contentDigest(Buffer.from('hello'))]);
    fake.bodyDigests = [];
    const data = randomBytes(2 * 5 * MiB + 3);
    await b.upload('d/big', Readable.from([data]));
    assert.ok(fake.objects.get('b/d/big')!.equals(data));
    const parts = fake.bodyDigests.filter((d) => d.path.includes('/parts/'));
    assert.equal(parts.length, 3);
    const want = [data.subarray(0, 5 * MiB), data.subarray(5 * MiB, 10 * MiB), data.subarray(10 * MiB)].map(contentDigest).sort();
    assert.deepEqual(parts.map((d) => d.digest).sort(), want);
    // JSON bodies (start, complete) carry one too.
    assert.ok(fake.bodyDigests.every((d) => d.digest), 'a body went without Content-Digest');
    // A body changed on the way is refused (400 bad_digest) and not sent again.
    fake.tamper = true;
    const n = fake.requests;
    try {
      await assert.rejects(b.put('d/t', 'data'), (e: any) => e instanceof ObjectStorageError && e.status === 400 && e.code === 'bad_digest');
    } finally {
      fake.tamper = false;
    }
    assert.equal(fake.requests - n, 1);
  });

  test('problem details', async () => {
    const b = client.bucket('b');
    const e: any = await b.getBytes('nope/x').catch((e) => e);
    assert.ok(e instanceof NotFoundError);
    assert.equal(e.status, 404);
    assert.equal(e.code, 'object_not_found');
    assert.match(e.message, /The object does not exist\./);
    assert.equal(e.type, 'tag:thailandhosting.com,2026:object-storage/object_not_found');
    assert.equal(e.instance, '/v1/buckets/b/objects/nope/x');
    // HEAD has no body: the code comes from X-Error-Code.
    await assert.rejects(b.head('nope/x'), (e: any) => e instanceof NotFoundError && e.code === 'object_not_found');
  });

  test('retries busy answers', async () => {
    fake.flaky = 2;
    await client.bucket('b').put('k', 'data');
    assert.equal(fake.objects.get('b/k')!.toString(), 'data');
  });

  test('honours Retry-After and signs each attempt afresh', async () => {
    fake.flaky = 1;
    fake.retryAfter = '1';
    fake.signatures = [];
    const t = Date.now();
    try {
      await client.bucket('b').put('ra', 'data');
    } finally {
      fake.retryAfter = '';
    }
    assert.ok(Date.now() - t >= 950, `retried after ${Date.now() - t} ms`);
    assert.equal(fake.signatures.length, 2);
    assert.notEqual(fake.signatures[0], fake.signatures[1]);
  });

  test('conditional writes', async () => {
    const b = client.bucket('b');
    const first = await b.put('c/k', 'one', { ifNoneMatch: '*' });
    const n = fake.requests;
    await assert.rejects(b.put('c/k', 'two', { ifNoneMatch: '*' }), (e: any) => e instanceof PreconditionFailedError && e.status === 412 && e.code === 'precondition_failed');
    assert.equal(fake.requests - n, 1, 'a 412 must not be retried');
    await assert.rejects(b.put('c/k', 'two', { ifNotExists: true }), PreconditionFailedError);
    await assert.rejects(b.put('c/k', 'two', { ifMatch: 'deadbeef' }), PreconditionFailedError);
    const second = await b.put('c/k', 'two', { ifMatch: first.etag });
    assert.equal(await b.getText('c/k'), 'two');
    await assert.rejects(b.delete('c/k', { ifMatch: first.etag }), PreconditionFailedError);
    assert.ok(fake.objects.has('b/c/k'));
    await b.delete('c/k', { ifMatch: `"${second.etag}"` });
    assert.ok(!fake.objects.has('b/c/k'));
    // A large upload checks its condition when the parts are joined, and is aborted when it fails.
    await b.put('c/big', 'taken');
    const src = join(dir, 'cond.bin');
    await writeFile(src, randomBytes(3 * 5 * MiB));
    await assert.rejects(b.uploadFile('c/big', src, { ifNoneMatch: '*' }), PreconditionFailedError);
    assert.equal(fake.objects.get('b/c/big')!.toString(), 'taken');
    assert.equal(fake.uploads.size, 0);
  });

  test('conditional reads', async () => {
    const b = client.bucket('b');
    const info = await b.put('c/r', 'read me');
    await assert.rejects(b.get('c/r', { ifNoneMatch: info.etag }), NotModifiedError);
    await assert.rejects(b.head('c/r', { ifNoneMatch: info.etag }), NotModifiedError);
    await assert.rejects(b.head('c/r', { ifModifiedSince: new Date(Date.now() + 60_000) }), NotModifiedError);
    await assert.rejects(b.head('c/r', { ifMatch: 'deadbeef' }), (e: any) => e instanceof PreconditionFailedError && e.code === 'precondition_failed');
    const dl = await b.get('c/r', { ifNoneMatch: 'other', ifMatch: info.etag });
    assert.equal(await new Response(dl.body).text(), 'read me');
  });

  test('downloads are checked against Repr-Digest', async () => {
    const b = client.bucket('b');
    await b.put('rd/x', 'payload');
    assert.equal((await b.head('rd/x')).digest, contentDigest(Buffer.from('payload')));
    assert.equal(await b.getText('rd/x'), 'payload');
    fake.digests.set('b/rd/x', contentDigest(Buffer.from('something else')));
    await assert.rejects(b.getBytes('rd/x'), (e: any) => e instanceof IntegrityError && /Repr-Digest/.test(e.message));
    const dl = await b.get('rd/x');
    await assert.rejects(new Response(dl.body).arrayBuffer(), IntegrityError);
    // A range is not the whole object: nothing to check.
    const part = await b.get('rd/x', { offset: 1, length: 3 });
    assert.equal(await new Response(part.body).text(), 'ayl');
    const dst = join(dir, 'rd', 'x');
    await assert.rejects(b.downloadFile('rd/x', dst), IntegrityError);
    await assert.rejects(access(dst));
    await assert.rejects(access(dst + '.download'));
    // Parallel ranges: the whole file is checked once it is in.
    const data = randomBytes(3 * 5 * MiB + 5);
    fake.objects.set('b/rd/big', data);
    fake.digests.set('b/rd/big', contentDigest(data));
    await b.downloadFile('rd/big', dst);
    assert.ok((await readFile(dst)).equals(data));
    fake.digests.set('b/rd/big', contentDigest(Buffer.from('x')));
    const dst2 = join(dir, 'rd', 'big2');
    await assert.rejects(b.downloadFile('rd/big', dst2), IntegrityError);
    await assert.rejects(access(dst2));
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
    assert.equal(fake.digests.get('b/small.bin'), contentDigest(Buffer.from('tiny')));
  });

  test('objects() pages through a listing', async () => {
    for (let i = 0; i < 25; i++) fake.objects.set(`b/p/${String(i).padStart(2, '0')}`, Buffer.from('x'));
    const keys: string[] = [];
    for await (const o of client.bucket('b').objects('p/', { pageSize: 10 })) keys.push(o.key);
    assert.deepEqual(keys, Array.from({ length: 25 }, (_, i) => `p/${String(i).padStart(2, '0')}`));
  });

  test('public access', async () => {
    const b = client.bucket('site');
    await b.put('public/a b.txt', 'hello');
    await b.put('private/x.txt', 'secret');
    assert.deepEqual(await b.setPublicAccess([{ prefix: 'public/' }]), [{ prefix: 'public/', list: false }]);
    assert.deepEqual(await b.publicAccess(), [{ prefix: 'public/', list: false }]);
    const base = new URL(b.publicUrl('x')).origin;
    assert.equal(b.publicUrl('public/a b.txt'), `${base}/site/public/a%20b.txt`);
    // Without a key the client reads what is public, nothing else.
    const anon = new Client({ endpoint: base });
    assert.equal(await anon.bucket('site').getText('public/a b.txt'), 'hello');
    await assert.rejects(anon.bucket('site').getText('private/x.txt'));
    assert.throws(() => new Client({ endpoint: base, accessKeyId: 'KEY' }));
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
      assert.ok((await b.head('notes/ไทย.txt')).digest?.startsWith('sha-256=:'));
      await assert.rejects(b.put('notes/ไทย.txt', 'again', { ifNoneMatch: '*' }), PreconditionFailedError);
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
