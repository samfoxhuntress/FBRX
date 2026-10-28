/**
 * The starter model "Install FBRX OS" downloads while it builds the app, so the first thing FBRX OS does is answer:
 * catalog entry qwen2.5-1.5b-instruct-q4km in packages/core/src/ai/runtime/catalog.ts (packages/core/test/starter-ai.test.ts
 * keeps the two the same). FBRX OS picks the file up from its models folder when it first opens and makes it the AI.
 * Dependency-free, like the wizard: it runs before `npm install`.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const STARTER_MODEL = {
  name: 'Qwen2.5 1.5B',
  url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  sizeBytes: 986_000_000,
};

/** Where the app looks for it: its models folder, under the file name the catalog download uses. */
export const starterModelFile = (modelsDir) => join(modelsDir, basename(new URL(STARTER_MODEL.url).pathname));

/**
 * Downloads the starter model into `modelsDir`, as a .part file until it is complete, so the app never sees half a
 * model. A broken-off download carries on where it stopped (this time or the next time setup runs). `progress.got` and
 * `progress.total` follow along. Resolves with the file, or rejects after `attempts` tries.
 */
export async function downloadStarterModel(modelsDir, progress = {}, { url = STARTER_MODEL.url, attempts = 3, retryMs = 3000, log = () => undefined } = {}) {
  mkdirSync(modelsDir, { recursive: true });
  const file = starterModelFile(modelsDir);
  const part = `${file}.part`;
  progress.got = 0;
  progress.total ??= STARTER_MODEL.sizeBytes;
  for (let attempt = 1; ; attempt++) {
    let have = existsSync(part) ? statSync(part).size : 0;
    try {
      const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (have && res.status !== 206) have = 0; // The server sent the whole file: start over.
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len) progress.total = have + len;
      progress.got = have;
      await pipeline(
        Readable.fromWeb(res.body),
        async function* (chunks) {
          for await (const c of chunks) {
            progress.got += c.length;
            yield c;
          }
        },
        createWriteStream(part, { flags: have ? 'a' : 'w' }),
      );
      if (len && statSync(part).size !== have + len) throw new Error('the download was cut short');
      renameSync(part, file);
      return file;
    } catch (err) {
      log(`starter model download, attempt ${attempt}: ${err.message}`);
      if (attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, retryMs * attempt));
    }
  }
}
