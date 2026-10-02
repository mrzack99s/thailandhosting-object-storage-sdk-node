import { createHash } from 'node:crypto';
import { open, mkdir, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { Readable } from 'node:stream';
import { IntegrityError, NotFoundError, NotModifiedError, ObjectStorageError } from './errors.ts';

export const VERSION = '1.0.0';

const MiB = 1024 * 1024;
const MIN_PART_SIZE = 5 * MiB;
const MAX_PARTS = 10000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface ClientOptions {
  /** The region's endpoint, e.g. https://objects.bkk.thailandhosting.com */
  endpoint: string;
  /** With secretAccessKey; leave both out for an anonymous client that reads only what buckets made public. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Size of each upload part and download range (default 16 MiB, at least 5 MiB). */
  partSize?: number;
  /** Size above which transfers are split (default 2 × partSize). */
  multipartThreshold?: number;
  /** Parts or ranges in flight at once (default 8). */
  concurrency?: number;
  /** Retries of requests that are safe to repeat (default 4). */
  maxRetries?: number;
  /** Appended to the SDK's User-Agent. */
  userAgent?: string;
  /** A fetch implementation (default: the global fetch). */
  fetch?: typeof fetch;
}

export interface BucketInfo {
  name: string;
  region: string;
  createdAt?: Date;
  /** What anyone may read; getBucket fills it, listBuckets does not. */
  public?: PublicRule[];
}

/** Makes the objects under `prefix` ("" is the whole bucket) readable by anyone without a key; `list` also lets anyone list those keys. */
export interface PublicRule {
  prefix: string;
  list?: boolean;
}

export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  lastModified?: Date;
  contentType?: string;
  metadata: Record<string, string>;
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  /** Stored with the object, returned as X-Meta-<name> (2 KB in all). */
  metadata?: Record<string, string>;
  /** Fail with code `precondition_failed` if the key already holds an object. */
  ifNotExists?: boolean;
  signal?: AbortSignal;
}

export interface GetOptions {
  /** Download `length` bytes from `offset` (length omitted: to the end). */
  offset?: number;
  length?: number;
  /** Throw NotModifiedError when the object's ETag is this one. */
  ifNoneMatch?: string;
  /** Fail with `precondition_failed` unless the object's ETag is this one. */
  ifMatch?: string;
  signal?: AbortSignal;
}

export interface ListOptions {
  prefix?: string;
  /** Roll keys up into folders ("/" lists one level). */
  delimiter?: string;
  cursor?: string;
  /** Page size, 1-1000 (default 1000). */
  limit?: number;
  signal?: AbortSignal;
}

export interface ListPage {
  objects: ObjectInfo[];
  folders: string[];
  /** Continues the listing; undefined on the last page. */
  nextCursor?: string;
}

export interface Part {
  number: number;
  etag: string;
  size: number;
}

export interface Link {
  url: string;
  method: 'GET' | 'PUT';
  expiresAt?: Date;
}

/** A download in progress. Read `body` (a web stream) or `toNodeStream()`. */
export interface ObjectDownload {
  info: ObjectInfo;
  contentRange?: string;
  body: ReadableStream<Uint8Array>;
  toNodeStream(): Readable;
}

type Body = string | Uint8Array;

interface RequestInit2 {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** Retry a POST on answers that mean nothing was done (429, 503). */
  retryPost?: boolean;
  /** Statuses that are not errors (default: any 2xx). */
  expect?: number[];
  signal?: AbortSignal;
}

const escapeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');

const toBytes = (b: Body): Uint8Array => (typeof b === 'string' ? Buffer.from(b) : b);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const backoff = (attempt: number) => {
  const d = Math.min(200 * 2 ** Math.min(attempt, 6), 10_000);
  return d / 2 + Math.random() * (d / 2);
};

function checkETag(etag: string, digest: string, what: string) {
  const e = etag.replace(/"/g, '');
  if (e.length === 32 && !e.includes('-') && e !== digest) {
    throw new IntegrityError(`${what}: the stored data does not match what was sent (ETag ${e}, MD5 ${digest})`);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv', '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};
const guessType = (name: string) => CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

const parseDate = (v?: string | null) => (v ? new Date(v) : undefined);

function objectFromJSON(d: any): ObjectInfo {
  return {
    key: d.key ?? '',
    size: Number(d.size ?? 0),
    etag: String(d.etag ?? '').replace(/"/g, ''),
    lastModified: parseDate(d.lastModified),
    contentType: d.contentType || undefined,
    metadata: d.metadata ?? {},
  };
}

function objectFromHeaders(key: string, h: Headers): ObjectInfo {
  const cr = h.get('content-range');
  const size = cr && cr.includes('/') ? Number(cr.split('/')[1]) : Number(h.get('content-length') ?? 0);
  const metadata: Record<string, string> = {};
  h.forEach((v, k) => { if (k.startsWith('x-meta-')) metadata[k.slice(7)] = v; });
  return { key, size, etag: (h.get('etag') ?? '').replace(/"/g, ''), lastModified: parseDate(h.get('last-modified')), contentType: h.get('content-type') ?? undefined, metadata };
}

/** Runs task(0..n-1), `workers` at a time; the first failure stops new work and is thrown. */
async function parallel(workers: number, n: number, task: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown;
  const run = async () => {
    while (failed === undefined && next < n) {
      const i = next++;
      try {
        await task(i);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, n) }, run));
  if (failed !== undefined) throw failed;
}

/** A client of one region's Object Storage endpoint. Reuse it: it keeps connections open. */
export class Client {
  readonly partSize: number;
  readonly multipartThreshold: number;
  readonly concurrency: number;
  readonly maxRetries: number;
  private readonly base: string;
  /** @internal */ readonly origin: string;
  private readonly auth: string;
  private readonly ua: string;
  private readonly fetch: typeof fetch;

  constructor(opts: ClientOptions) {
    if (!opts.endpoint || !opts.accessKeyId !== !opts.secretAccessKey) {
      throw new Error('endpoint is required, and accessKeyId and secretAccessKey together');
    }
    const u = new URL(opts.endpoint);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`invalid endpoint ${opts.endpoint}`);
    const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.origin = `${u.protocol}//${u.host}${path}`;
    this.base = `${this.origin}/v1`;
    this.auth = opts.accessKeyId ? `Bearer ${opts.accessKeyId}:${opts.secretAccessKey}` : '';
    this.partSize = Math.max(opts.partSize ?? 16 * MiB, MIN_PART_SIZE);
    this.multipartThreshold = opts.multipartThreshold ?? 2 * this.partSize;
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
    this.maxRetries = Math.max(0, opts.maxRetries ?? 4);
    this.ua = `thailandhosting-object-storage-sdk-node/${VERSION}${opts.userAgent ? ' ' + opts.userAgent : ''}`;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** @internal Sends a request with retries; the caller reads or cancels the body. */
  async request(r: RequestInit2): Promise<Response> {
    let url = this.base + r.path;
    if (r.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(r.query)) if (v !== undefined && v !== '') q.set(k, String(v));
      const s = q.toString();
      if (s) url += '?' + s;
    }
    const headers: Record<string, string> = { 'User-Agent': this.ua, ...r.headers };
    if (this.auth) headers.Authorization = this.auth;
    for (let attempt = 0; ; attempt++) {
      let resp: Response;
      try {
        resp = await this.fetch(url, { method: r.method, headers, body: r.body as BodyInit | undefined, signal: r.signal, redirect: 'manual' });
      } catch (e) {
        if (r.signal?.aborted) throw e;
        // The request may have reached the service; only a repeatable one is sent again.
        if (attempt < this.maxRetries && (r.method !== 'POST' || r.retryPost)) {
          await sleep(backoff(attempt), r.signal);
          continue;
        }
        throw e;
      }
      const okStatus = r.expect ? r.expect.includes(resp.status) : resp.status >= 200 && resp.status < 300;
      if (okStatus) return resp;
      const err = await readError(resp);
      const retryable = RETRY_STATUSES.has(resp.status) && (r.method !== 'POST' || (!!r.retryPost && (resp.status === 429 || resp.status === 503)));
      if (retryable && attempt < this.maxRetries) {
        let wait = backoff(attempt);
        const ra = Number(resp.headers.get('retry-after'));
        if (ra > 0 && ra < 30) wait = Math.max(wait, ra * 1000);
        await sleep(wait, r.signal);
        continue;
      }
      throw err;
    }
  }

  /** @internal */
  async json<T = any>(method: string, path: string, payload?: unknown, opts: { query?: RequestInit2['query']; retryPost?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const resp = await this.request({
      method, path, query: opts.query, retryPost: opts.retryPost, signal: opts.signal,
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)),
    });
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** The buckets this access key can use. */
  async listBuckets(signal?: AbortSignal): Promise<BucketInfo[]> {
    const d = await this.json('GET', '/buckets', undefined, { signal });
    return d.buckets.map((b: any) => ({ name: b.name, region: b.region, createdAt: parseDate(b.createdAt) }));
  }

  /** Create a bucket (3-63 characters of a-z, 0-9, dots and hyphens). */
  async createBucket(name: string, signal?: AbortSignal): Promise<BucketInfo> {
    const b = await this.json('PUT', '/buckets/' + encodeURIComponent(name), undefined, { signal });
    return { name: b?.name ?? name, region: b?.region ?? '', createdAt: parseDate(b?.createdAt), public: b?.public };
  }

  async getBucket(name: string, signal?: AbortSignal): Promise<BucketInfo> {
    const b = await this.json('GET', '/buckets/' + encodeURIComponent(name), undefined, { signal });
    return { name: b.name, region: b.region, createdAt: parseDate(b.createdAt) };
  }

  /** Delete an empty bucket. */
  async deleteBucket(name: string, signal?: AbortSignal): Promise<void> {
    await this.json('DELETE', '/buckets/' + encodeURIComponent(name), undefined, { signal });
  }

  /** A handle for one bucket's objects (no request is made). */
  bucket(name: string): Bucket {
    return new Bucket(this, name);
  }

  /** @internal */
  partSizeFor(size: number): number {
    let ps = this.partSize;
    if (size > 0 && Math.ceil(size / ps) > MAX_PARTS) ps = Math.ceil(Math.ceil(size / MAX_PARTS) / MiB) * MiB;
    return ps;
  }
}

async function readError(resp: Response): Promise<ObjectStorageError> {
  let code = resp.headers.get('x-error-code') ?? '';
  let message = resp.statusText;
  try {
    const doc = JSON.parse(await resp.text());
    code = doc?.error?.code || code;
    message = doc?.error?.message || message;
  } catch {
    // not JSON
  }
  code ||= (resp.statusText || 'error').toLowerCase().replace(/ /g, '_');
  return resp.status === 404 ? new NotFoundError(code, message) : new ObjectStorageError(resp.status, code, message);
}

function putHeaders(key: string, o: PutOptions = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': o.contentType || guessType(key) };
  if (o.cacheControl) h['Cache-Control'] = o.cacheControl;
  if (o.contentDisposition) h['Content-Disposition'] = o.contentDisposition;
  if (o.contentEncoding) h['Content-Encoding'] = o.contentEncoding;
  for (const [k, v] of Object.entries(o.metadata ?? {})) h['X-Meta-' + k] = v;
  if (o.ifNotExists) h['If-None-Match'] = '*';
  return h;
}

/** The objects of one bucket. */
export class Bucket {
  readonly name: string;
  /** @internal */ readonly c: Client;
  /** @internal */ readonly path: string;

  constructor(client: Client, name: string) {
    this.c = client;
    this.name = name;
    this.path = '/buckets/' + encodeURIComponent(name);
  }

  private obj(key: string) {
    return this.path + '/objects/' + escapeKey(key);
  }

  /** Upload a string or bytes in one request. */
  async put(key: string, data: Body, opts: PutOptions = {}): Promise<ObjectInfo> {
    const bytes = toBytes(data);
    const resp = await this.c.request({ method: 'PUT', path: this.obj(key), headers: putHeaders(key, opts), body: bytes, signal: opts.signal });
    const info = objectFromJSON(await resp.json());
    checkETag(info.etag, md5(bytes), key);
    return info;
  }

  /** Stream an object (or a range of it). `info.size` is the whole object's size. */
  async get(key: string, opts: GetOptions = {}): Promise<ObjectDownload> {
    const headers: Record<string, string> = {};
    if (opts.offset || opts.length) {
      const start = opts.offset ?? 0;
      headers.Range = opts.length ? `bytes=${start}-${start + opts.length - 1}` : `bytes=${start}-`;
    }
    if (opts.ifNoneMatch) headers['If-None-Match'] = `"${opts.ifNoneMatch.replace(/"/g, '')}"`;
    if (opts.ifMatch) headers['If-Match'] = `"${opts.ifMatch.replace(/"/g, '')}"`;
    const resp = await this.c.request({ method: 'GET', path: this.obj(key), headers, expect: [200, 206, 304], signal: opts.signal });
    if (resp.status === 304) {
      await resp.body?.cancel();
      throw new NotModifiedError(key);
    }
    const body = resp.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    return {
      info: objectFromHeaders(key, resp.headers),
      contentRange: resp.headers.get('content-range') ?? undefined,
      body,
      toNodeStream: () => Readable.fromWeb(body as any),
    };
  }

  /** Download a whole object into memory. */
  async getBytes(key: string, signal?: AbortSignal): Promise<Uint8Array> {
    const resp = await this.c.request({ method: 'GET', path: this.obj(key), signal });
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** Download a whole object as UTF-8 text. */
  async getText(key: string, signal?: AbortSignal): Promise<string> {
    const resp = await this.c.request({ method: 'GET', path: this.obj(key), signal });
    return resp.text();
  }

  async head(key: string, signal?: AbortSignal): Promise<ObjectInfo> {
    const resp = await this.c.request({ method: 'HEAD', path: this.obj(key), signal });
    return objectFromHeaders(key, resp.headers);
  }

  async exists(key: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.head(key, signal);
      return true;
    } catch (e) {
      if (e instanceof NotFoundError) return false;
      throw e;
    }
  }

  /** Delete an object; deleting a missing one succeeds. */
  async delete(key: string, signal?: AbortSignal): Promise<void> {
    const resp = await this.c.request({ method: 'DELETE', path: this.obj(key), signal });
    await resp.body?.cancel();
  }

  /** Delete keys in parallel. */
  async deleteMany(keys: string[], signal?: AbortSignal): Promise<void> {
    await parallel(this.c.concurrency, keys.length, (i) => this.delete(keys[i]!, signal));
  }

  /** Copy inside the service, without downloading. */
  async copy(srcKey: string, dstKey: string, opts: { sourceBucket?: string; metadata?: Record<string, string>; signal?: AbortSignal } = {}): Promise<ObjectInfo> {
    const payload: any = { from: { bucket: opts.sourceBucket ?? this.name, key: srcKey }, key: dstKey };
    if (opts.metadata) payload.metadata = opts.metadata;
    return objectFromJSON(await this.c.json('POST', this.path + '/copy', payload, { retryPost: true, signal: opts.signal }));
  }

  /** One page of objects (and folders, with a delimiter). */
  async list(opts: ListOptions = {}): Promise<ListPage> {
    const d = await this.c.json('GET', this.path + '/objects', undefined, {
      query: { prefix: opts.prefix, delimiter: opts.delimiter, cursor: opts.cursor, limit: opts.limit }, signal: opts.signal,
    });
    return { objects: (d.objects ?? []).map(objectFromJSON), folders: d.folders ?? [], nextCursor: d.nextCursor || undefined };
  }

  /** Every object under prefix: `for await (const obj of bucket.objects('photos/'))`. */
  async *objects(prefix = '', opts: { pageSize?: number; signal?: AbortSignal } = {}): AsyncGenerator<ObjectInfo> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ prefix, cursor, limit: opts.pageSize, signal: opts.signal });
      yield* page.objects;
      cursor = page.nextCursor;
    } while (cursor);
  }

  /** A URL that downloads (or, with `upload: true`, uploads) one object without a key. */
  async createLink(key: string, opts: { expiresIn?: number; upload?: boolean; signal?: AbortSignal } = {}): Promise<Link> {
    const d = await this.c.json('POST', this.path + '/links', { key, expiresIn: opts.expiresIn ?? 3600, method: opts.upload ? 'PUT' : 'GET' }, { retryPost: true, signal: opts.signal });
    return { url: d.url, method: d.method, expiresAt: parseDate(d.expiresAt) };
  }

  /** What anyone may read in the bucket. */
  async publicAccess(opts: { signal?: AbortSignal } = {}): Promise<PublicRule[]> {
    const d = await this.c.json('GET', this.path + '/public', undefined, { signal: opts.signal });
    return d.rules ?? [];
  }

  /**
   * Replace what anyone may read: `[]` makes the bucket private, `[{ prefix: '' }]` opens all of it,
   * `[{ prefix: 'images/' }]` one folder. Needs a key allowed to manage buckets; takes effect within
   * about 15 seconds. Resolves to the rules as stored.
   */
  async setPublicAccess(rules: PublicRule[], opts: { signal?: AbortSignal } = {}): Promise<PublicRule[]> {
    const payload = { rules: rules.map((r) => ({ prefix: r.prefix, list: !!r.list })) };
    const d = await this.c.json('PUT', this.path + '/public', payload, { retryPost: true, signal: opts.signal });
    return d.rules ?? [];
  }

  /** The address anyone can open `key` at once its folder (or the bucket) is public. No request is made. */
  publicUrl(key: string): string {
    return `${this.c.origin}/${encodeURIComponent(this.name)}/${escapeKey(key)}`;
  }

  /** Start a multipart upload (uploadFile and upload do this for you). */
  async createMultipartUpload(key: string, opts: PutOptions = {}): Promise<MultipartUpload> {
    const payload: any = { key, contentType: opts.contentType || guessType(key) };
    if (opts.metadata) payload.metadata = opts.metadata;
    const d = await this.c.json('POST', this.path + '/uploads', payload, { retryPost: true, signal: opts.signal });
    return new MultipartUpload(this, key, d.uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    return new MultipartUpload(this, key, uploadId);
  }

  /** Upload a local file. Large files go up as parts read from the file and
   *  sent in parallel; a part is re-read if it must be sent again. */
  async uploadFile(key: string, path: string, opts: PutOptions = {}): Promise<ObjectInfo> {
    const { size } = await stat(path);
    const options = { ...opts, contentType: opts.contentType || guessType(path) };
    const fh = await open(path, 'r');
    try {
      if (size <= this.c.multipartThreshold) {
        const buf = Buffer.allocUnsafe(size);
        await readFully(fh, buf, 0);
        return await this.put(key, buf, options);
      }
      const ps = this.c.partSizeFor(size);
      const count = Math.ceil(size / ps);
      const up = await this.createMultipartUpload(key, options);
      const parts: Part[] = new Array(count);
      try {
        await parallel(this.c.concurrency, count, async (i) => {
          const len = Math.min(ps, size - i * ps);
          const buf = Buffer.allocUnsafe(len);
          await readFully(fh, buf, i * ps);
          parts[i] = await up.uploadPart(i + 1, buf, opts.signal);
        });
        return await up.complete(parts, opts.signal);
      } catch (e) {
        await up.abortQuietly();
        throw e;
      }
    } finally {
      await fh.close();
    }
  }

  /** Upload what a stream yields (a pipe, an HTTP request, a generated
   *  export) without knowing its size. Parts are sent in parallel, holding at
   *  most `concurrency + 1` in memory. */
  async upload(key: string, source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, opts: PutOptions = {}): Promise<ObjectInfo> {
    const ps = this.c.partSize;
    const chunks = partChunks(source, ps);
    const first = await chunks.next();
    if (first.done) return this.put(key, new Uint8Array(0), opts);
    const second = first.value.length < ps ? await chunks.next() : undefined;
    if (second?.done) return this.put(key, first.value, opts);
    const up = await this.createMultipartUpload(key, opts);
    const parts: Part[] = [];
    const inflight = new Set<Promise<void>>();
    let failed: unknown;
    try {
      let n = 1;
      const send = (data: Uint8Array, num: number) => {
        const p: Promise<void> = up.uploadPart(num, data, opts.signal)
          .then((part) => { parts.push(part); }, (e) => { failed ??= e; })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      };
      send(first.value, n++);
      if (second && !second.done) send(second.value, n++);
      for await (const data of chunks) {
        if (failed !== undefined) break;
        if (n > MAX_PARTS) throw new Error(`more than ${MAX_PARTS} parts of ${ps} bytes: use a larger partSize`);
        while (inflight.size >= this.c.concurrency) await Promise.race(inflight);
        if (failed !== undefined) break;
        send(data, n++);
      }
      await Promise.all(inflight);
      if (failed !== undefined) throw failed;
      return await up.complete(parts, opts.signal);
    } catch (e) {
      await Promise.allSettled(inflight);
      await up.abortQuietly();
      throw e;
    }
  }

  /** Save an object to `path`. Large objects come down as parallel ranges
   *  pinned to the object's ETag, written straight to their place in the
   *  file; the data goes to `path + '.download'` and is renamed into place. */
  async downloadFile(key: string, path: string, signal?: AbortSignal): Promise<ObjectInfo> {
    const info = await this.head(key, signal);
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + '.download';
    const fh = await open(tmp, 'w');
    try {
      await fh.truncate(info.size);
      if (info.size <= this.c.multipartThreshold) {
        const hash = createHash('md5');
        const dl = await this.get(key, { ifMatch: info.etag, signal });
        let pos = 0;
        for await (const chunk of dl.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          await writeFully(fh, chunk, pos);
          pos += chunk.length;
        }
        if (pos !== info.size) throw new IntegrityError(`${key}: got ${pos} of ${info.size} bytes`);
        checkETag(info.etag, hash.digest('hex'), key);
      } else {
        const ps = this.c.partSize;
        await parallel(this.c.concurrency, Math.ceil(info.size / ps), (i) =>
          this.downloadRange(key, info.etag, fh, i * ps, Math.min(ps, info.size - i * ps), signal));
      }
      await fh.close();
      await rename(tmp, path);
      return info;
    } catch (e) {
      await fh.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw e;
    }
  }

  private async downloadRange(key: string, etag: string, fh: FileHandle, offset: number, length: number, signal?: AbortSignal) {
    let done = 0;
    for (let attempt = 0; done < length; attempt++) {
      try {
        const dl = await this.get(key, { offset: offset + done, length: length - done, ifMatch: etag, signal });
        for await (const chunk of dl.body as unknown as AsyncIterable<Uint8Array>) {
          await writeFully(fh, chunk, offset + done);
          done += chunk.length;
        }
      } catch (e) {
        if (e instanceof ObjectStorageError || signal?.aborted || attempt >= this.c.maxRetries) throw e;
      }
      if (done < length) {
        // The connection broke mid-range: carry on from where it stopped.
        if (attempt >= this.c.maxRetries) throw new IntegrityError(`${key}: got ${done} of ${length} bytes at ${offset}`);
        await sleep(backoff(attempt), signal);
      }
    }
  }
}

/** A large upload in progress: send parts (any order, in parallel), then complete() or abort(). */
export class MultipartUpload {
  readonly bucket: Bucket;
  readonly key: string;
  readonly uploadId: string;

  constructor(bucket: Bucket, key: string, uploadId: string) {
    this.bucket = bucket;
    this.key = key;
    this.uploadId = uploadId;
  }

  private get path() {
    return this.bucket.path + '/uploads/' + this.uploadId;
  }

  /** Send part `n` (1-10000); every part but the last must be at least 5 MiB. */
  async uploadPart(n: number, data: Body, signal?: AbortSignal): Promise<Part> {
    const bytes = toBytes(data);
    const resp = await this.bucket.c.request({
      method: 'PUT', path: `${this.path}/parts/${n}`, headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, signal,
    });
    const d: any = await resp.json();
    checkETag(String(d.etag), md5(bytes), `part ${n}`);
    return { number: Number(d.number), etag: String(d.etag).replace(/"/g, ''), size: bytes.length };
  }

  async parts(signal?: AbortSignal): Promise<Part[]> {
    const d = await this.bucket.c.json('GET', this.path, undefined, { signal });
    return (d.parts ?? []).map((p: any) => ({ number: p.number, etag: p.etag, size: p.size }));
  }

  /** Join the parts into the object; without `parts`, every part received, in order. */
  async complete(parts?: Part[], signal?: AbortSignal): Promise<ObjectInfo> {
    const payload = parts ? { parts: [...parts].sort((a, b) => a.number - b.number).map((p) => ({ number: p.number, etag: p.etag })) } : undefined;
    try {
      return objectFromJSON(await this.bucket.c.json('POST', this.path + '/complete', payload, { retryPost: true, signal }));
    } catch (e) {
      // A retry after a completion whose answer was lost.
      if (e instanceof NotFoundError) return this.bucket.head(this.key, signal);
      throw e;
    }
  }

  async abort(signal?: AbortSignal): Promise<void> {
    try {
      await this.bucket.c.json('DELETE', this.path, undefined, { signal });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  /** @internal */
  async abortQuietly() {
    await this.abort().catch(() => undefined);
  }
}

async function readFully(fh: FileHandle, buf: Buffer, position: number) {
  let off = 0;
  while (off < buf.length) {
    const { bytesRead } = await fh.read(buf, off, buf.length - off, position + off);
    if (bytesRead === 0) throw new Error('file shrank while it was being uploaded');
    off += bytesRead;
  }
}

async function writeFully(fh: FileHandle, data: Uint8Array, position: number) {
  let off = 0;
  while (off < data.length) {
    const { bytesWritten } = await fh.write(data, off, data.length - off, position + off);
    off += bytesWritten;
  }
}

/** Regroups a stream's chunks into parts of exactly `size` bytes (the last may be shorter). */
async function* partChunks(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let buf = Buffer.allocUnsafe(size);
  let fill = 0;
  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(size - fill, chunk.length - off);
      buf.set(chunk.subarray(off, off + n), fill);
      fill += n;
      off += n;
      if (fill === size) {
        yield buf;
        buf = Buffer.allocUnsafe(size);
        fill = 0;
      }
    }
  }
  if (fill > 0) yield buf.subarray(0, fill);
}
