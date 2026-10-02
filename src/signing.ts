// Request signing: HTTP Message Signatures (RFC 9421) with HMAC-SHA256 keyed
// with the access key's secret, so the secret itself is never sent. A body is
// tied to the signature through its Content-Digest (RFC 9530).
import { createHash, createHmac } from 'node:crypto';

const LABEL = 'th';
const ALG = 'hmac-sha256';
const COMPONENTS = ['@method', '@authority', '@path', '@query'];

export interface SignInput {
  method: string;
  /** The full request URL, exactly as it will be sent. */
  url: string | URL;
  accessKeyId: string;
  secretAccessKey: string;
  /** The Content-Digest header sent with a body; leave out for a request without one. */
  contentDigest?: string;
  /** Unix seconds (default: now). */
  created?: number;
}

/** The Content-Digest (RFC 9530) of a body: `sha-256=:<base64>:`. */
export const contentDigest = (body: Uint8Array) => `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;

/** The base64 SHA-256 a Digest field (Repr-Digest, Content-Digest) gives, if it has one. */
export function sha256FromField(field?: string | null): string | undefined {
  for (const member of (field ?? '').split(',')) {
    const m = /^\s*sha-256=:([A-Za-z0-9+/=]*):/.exec(member);
    if (m) return m[1];
  }
  return undefined;
}

const sfString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** @internal The @signature-params value: Signature-Input after `th=`. */
export function signatureParams(keyId: string, created: number, withDigest: boolean): string {
  const covered = withDigest ? [...COMPONENTS, 'content-digest'] : COMPONENTS;
  return `(${covered.map(sfString).join(' ')});created=${created};keyid=${sfString(keyId)};alg="${ALG}"`;
}

/** @internal The bytes that are signed (RFC 9421 section 2.5), no trailing newline. */
export function signatureBase(method: string, url: string | URL, params: string, digest?: string): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  const authority = u.host.toLowerCase().replace(/:(443|80)$/, '');
  const lines = [
    `"@method": ${method.toUpperCase()}`,
    `"@authority": ${authority}`,
    `"@path": ${u.pathname || '/'}`,
    `"@query": ?${u.search.slice(1)}`,
  ];
  if (digest !== undefined) lines.push(`"content-digest": ${digest}`);
  lines.push(`"@signature-params": ${params}`);
  return lines.join('\n');
}

/** The Signature-Input and Signature headers of one request. Sign each attempt afresh. */
export function signRequest(i: SignInput): { 'Signature-Input': string; Signature: string } {
  const created = i.created ?? Math.floor(Date.now() / 1000);
  const params = signatureParams(i.accessKeyId, created, i.contentDigest !== undefined);
  const base = signatureBase(i.method, i.url, params, i.contentDigest);
  const sig = createHmac('sha256', i.secretAccessKey).update(base, 'utf8').digest('base64');
  return { 'Signature-Input': `${LABEL}=${params}`, Signature: `${LABEL}=:${sig}:` };
}
