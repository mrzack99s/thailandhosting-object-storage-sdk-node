/**
 * Node.js SDK for ThailandHosting Object Storage.
 *
 * ```ts
 * import { Client } from '@thailandhosting/object-storage';
 *
 * const client = new Client({
 *   endpoint: 'https://objects.bkk.thailandhosting.com',
 *   accessKeyId: process.env.TH_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.TH_SECRET_ACCESS_KEY!,
 * });
 * const bucket = client.bucket('my-bucket');
 * await bucket.uploadFile('backups/db.dump', '/var/backups/db.dump');
 * ```
 */
export { Client, Bucket, MultipartUpload, VERSION } from './client.ts';
export type {
  BucketInfo, ClientOptions, CompleteOptions, DeleteOptions, GetOptions, HeadOptions, Link, ListOptions, ListPage, ObjectDownload, ObjectInfo, Part,
  PublicRule, PutOptions, WriteConditions,
} from './client.ts';
export { IntegrityError, NotFoundError, NotModifiedError, ObjectStorageError, PreconditionFailedError } from './errors.ts';
export { contentDigest, signRequest } from './signing.ts';
export type { SignInput } from './signing.ts';
