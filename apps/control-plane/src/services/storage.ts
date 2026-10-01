import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../errors';

/** Streams an upload to disk while computing sha256/sha512, enforcing a size limit. */
export async function storeStream(
  source: Readable,
  dest: string,
  maxBytes: number,
): Promise<{ size: number; sha256: string; sha512: string }> {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.uploading`;
  const h256 = createHash('sha256');
  const h512 = createHash('sha512');
  let size = 0;
  try {
    await pipeline(
      source,
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          size += chunk.length;
          if (size > maxBytes) throw new HttpError(413, 'Upload exceeds the size limit');
          h256.update(chunk);
          h512.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    if (size === 0) throw new HttpError(400, 'Empty upload');
    await rename(tmp, dest);
    return { size, sha256: h256.digest('hex'), sha512: h512.digest('base64') };
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
