# ThailandHosting Object Storage — Node.js SDK

TypeScript/JavaScript client for ThailandHosting Object Storage: buckets,
objects, large files and share links over the ThailandHosting API.

```
npm install @thailandhosting/object-storage
```

Node.js 18.17+. ESM with TypeScript types. No runtime dependencies: it uses
Node's built-in `fetch` (keep-alive connection pooling) and streams.

## Quick start

```ts
import { Client, NotFoundError } from '@thailandhosting/object-storage';

const client = new Client({
  endpoint: 'https://objects.bkk.thailandhosting.com',
  accessKeyId: process.env.TH_ACCESS_KEY_ID!,
  secretAccessKey: process.env.TH_SECRET_ACCESS_KEY!,
});
const bucket = client.bucket('my-bucket');

// Any size: large files go up as parallel parts.
await bucket.uploadFile('backups/db.dump', '/var/backups/db.dump');

// Large objects come down as parallel ranges.
await bucket.downloadFile('backups/db.dump', '/tmp/db.dump');

// Small objects
await bucket.put('notes/hello.txt', 'สวัสดี', { metadata: { author: 'me' } });
console.log(await bucket.getText('notes/hello.txt'));

// Stream an upload of unknown length (an HTTP request, a pipe, a generated export)
await bucket.upload('exports/report.csv', someReadable);

// Stream a download
const dl = await bucket.get('videos/intro.mp4');
dl.toNodeStream().pipe(res);

// Every object under a prefix
for await (const obj of bucket.objects('backups/')) console.log(obj.key, obj.size);

// A link that works without a key for one hour
console.log((await bucket.createLink('backups/db.dump', { expiresIn: 3600 })).url);

try {
  await bucket.head('missing');
} catch (e) {
  if (e instanceof NotFoundError) console.log(e.code); // object_not_found
}
```

Create access keys in the Console (Object Storage → Access keys). Reuse one
`Client`: it keeps connections open. Every call takes an optional
`AbortSignal`.

## Authentication

Every request is signed with HTTP Message Signatures (RFC 9421,
HMAC-SHA256 keyed with the secret access key). The secret itself is never
sent: the request carries `Signature-Input` (covering the method, host, path,
query and, with a body, its `Content-Digest`) and `Signature`. Each attempt is
signed afresh, so the machine's clock must be within 5 minutes of the
service's. A client without a key sends no signature.

`signRequest` and `contentDigest` are exported for signing requests made
with your own HTTP client.

## Conditional writes

```ts
import { PreconditionFailedError } from '@thailandhosting/object-storage';

// Create only if the key is free (also on uploadFile / upload, where the
// condition is checked when a large upload's parts are joined).
await bucket.put('locks/job-42', owner, { ifNoneMatch: '*' });

// Replace only the version you read; delete only if unchanged.
const info = await bucket.head('config.json');
try {
  await bucket.put('config.json', next, { ifMatch: info.etag });
} catch (e) {
  if (e instanceof PreconditionFailedError) console.log('changed meanwhile'); // code precondition_failed
}
await bucket.delete('config.json', { ifMatch: info.etag });

// Reads: NotModifiedError when the cached copy is current.
await bucket.get('logo.png', { ifNoneMatch: cachedETag });
await bucket.head('logo.png', { ifModifiedSince: cachedAt });
```

The service checks `ifMatch` / `ifNoneMatch` atomically with the write. A
failed condition is `PreconditionFailedError` (HTTP 412) and is never retried.

## Public buckets and folders

```ts
// Anyone may read images/ (and nothing else) without a key; needs a key
// allowed to manage buckets. [] makes the bucket private again.
await bucket.setPublicAccess([{ prefix: 'images/' }]);
console.log(bucket.publicUrl('images/logo.png'));
// https://objects.bkk.thailandhosting.com/my-bucket/images/logo.png

// A client without a key reads (and, where allowed, lists) public objects.
const anon = new Client({ endpoint: 'https://objects.bkk.thailandhosting.com' });
const logo = await anon.bucket('my-bucket').getBytes('images/logo.png');
```

What a key may do (buckets, folders, read / list / write / delete,
managing buckets, an expiry date) is set on the key in the Console.

## Performance

| | |
|---|---|
| Connections | Node's `fetch` (undici): keep-alive pooling, no per-request handshake |
| Uploads | `uploadFile` reads parts with positional reads and sends them in parallel; `upload` streams any `Readable` / `ReadableStream` / async iterable, holding at most `concurrency + 1` parts in memory |
| Downloads | `downloadFile` fetches parallel ranges and writes each straight to its place in the file; `get` streams |
| Small data | one request; a stream that turns out small is one request too |
| Tuning | `partSize` (default 16 MiB), `concurrency` (default 8), `multipartThreshold` (default 32 MiB) |

## Reliability

- Requests that are safe to repeat are retried with exponential backoff and
  jitter (`maxRetries`, default 4) on 429, 500, 502, 503, 504 and network
  errors, waiting at least as long as `Retry-After` asks.
- Every request body (each part, and JSON) carries a `Content-Digest`
  (SHA-256); the service checks it as the bytes arrive and refuses a body
  that changed on the way (`bad_digest`, not retried). Streams are cut into
  parts in memory, so their digest is known before they are sent.
- Every single upload and every part is checked against the MD5 the service
  reports; damaged data throws `IntegrityError` and is never accepted.
- An object uploaded in one request has a `Repr-Digest` (`info.digest`).
  Whole-object downloads (`getBytes`, `getText`, `get` without a range,
  `downloadFile` including its parallel ranges) are checked against it and
  throw `IntegrityError` if the bytes differ. Multipart uploads have none.
- A failed multipart upload is aborted, so its parts are not billed.
- `downloadFile` writes to `path + '.download'` and renames it into place;
  every range is pinned to the object's ETag, and a broken range resumes
  where it stopped.

## API

| `Client` | |
|---|---|
| `listBuckets()`, `createBucket(name)`, `getBucket(name)`, `deleteBucket(name)` | buckets |
| `bucket(name)` | a `Bucket` handle |

| `Bucket` | |
|---|---|
| `put`, `upload`, `uploadFile` | upload (`contentType`, `metadata`, `cacheControl`, `contentDisposition`, `contentEncoding`, `ifMatch`, `ifNoneMatch`, `ifNotExists`) |
| `get` (`offset`/`length`, `ifNoneMatch` / `ifModifiedSince` → `NotModifiedError`, `ifMatch` / `ifUnmodifiedSince`), `getBytes`, `getText`, `downloadFile` | download |
| `head` (same conditions as `get`), `exists`, `delete` (`ifMatch`, `ifNoneMatch`), `deleteMany`, `copy` | object operations |
| `list` (one page), `objects` (async iterator) | listing |
| `createLink(key, { expiresIn, upload })` | a link that needs no key |
| `publicAccess()`, `setPublicAccess(rules)`, `publicUrl(key)` | make the bucket or some folders readable by anyone, and their URLs |
| `createMultipartUpload`, `resumeMultipartUpload` → `uploadPart`, `parts`, `complete` (`ifMatch`, `ifNoneMatch`), `abort` | do-it-yourself multipart |

The service answers errors as Problem Details (RFC 9457,
`application/problem+json`). They throw `ObjectStorageError` with `status`,
`code` (for example `object_not_found`, `bucket_already_exists`, `busy`), the
problem's title in `message`, and `type` / `instance`. `NotFoundError` is the
404 case and `PreconditionFailedError` the 412 one.

## Development

```
npm install
npm test          # runs the TypeScript tests directly (Node 22.6+ type stripping)
npm run build     # dist/ (ESM + .d.ts)
```

`npm test` uses an in-memory fake of the service. Set
`TH_OBJECT_STORAGE_ENDPOINT`, `TH_ACCESS_KEY_ID` and `TH_SECRET_ACCESS_KEY`
to also run a round trip against a real endpoint (it creates and deletes a
bucket).
