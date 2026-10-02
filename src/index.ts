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
export type { BucketInfo, ClientOptions, GetOptions, Link, ListOptions, ListPage, ObjectDownload, ObjectInfo, Part, PutOptions } from './client.ts';
export { IntegrityError, NotFoundError, NotModifiedError, ObjectStorageError } from './errors.ts';
