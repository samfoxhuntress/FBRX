/**
 * Fetches the official llama.cpp `llama-server` for a target OS/CPU into apps/desktop/resources/runtime so
 * electron-builder bundles it (CI runs this per platform before packaging).
 *
 *   npx tsx scripts/fetch-llama-runtime.ts [--platform darwin|win32|linux] [--arch x64|arm64] [--tag b6600] [--variant cpu|vulkan]
 */
import { resolve } from 'node:path';
import { installLlamaRuntime } from '../packages/core/src/ai/runtime/runtime-installer';

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? undefined : process.argv[i + 1];
};
const platform = (arg('--platform') ?? process.platform) as NodeJS.Platform;
const arches = (arg('--arch') ?? process.arch).split(',');
for (const arch of arches) {
  const r = await installLlamaRuntime({
    destDir: resolve('apps/desktop/resources/runtime'),
    platform,
    arch,
    tag: arg('--tag') ?? process.env.LLAMA_CPP_TAG,
    variant: (arg('--variant') as 'cpu' | 'vulkan') ?? 'cpu',
    githubToken: process.env.GITHUB_TOKEN,
    onProgress: (got, total, phase) => process.stdout.write(`\r${phase} ${platform}-${arch} ${total ? Math.round((got / total) * 100) : 0}%   `),
  });
  console.log(`\nInstalled ${r.asset} (${r.tag}) → ${r.binary}`);
}
