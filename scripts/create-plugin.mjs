#!/usr/bin/env node
/**
 * Scaffolds a new FBRX OS plugin under plugins/<name>.
 *
 *   npm run plugin:create -- <name> [--id com.acme.my-tool] [--namespace my_tool] [--ts]
 *
 * Then: edit the tools in index.mjs (or src/index.ts with --ts), run `npm run pack:plugin -w plugins/<name>`,
 * and install the resulting .tgz from the desktop app or push it to your fleet from the admin console.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const name = args.find((a, i) => !a.startsWith('--') && !['--id', '--namespace'].includes(args[i - 1]));
if (!name || !/^[a-z][a-z0-9-]{1,40}$/.test(name)) {
  console.error('Usage: npm run plugin:create -- <name> [--id com.acme.name] [--namespace name] [--ts]\n  <name>: lowercase letters, digits and dashes');
  process.exit(2);
}
const ts = args.includes('--ts');
const id = opt('--id') ?? `com.fbrx.${name}`;
const namespace = opt('--namespace') ?? name.replace(/-/g, '_').slice(0, 32);
const dir = join(root, 'plugins', name);
if (existsSync(dir)) {
  console.error(`${relative(process.cwd(), dir)} already exists`);
  process.exit(1);
}
const title = name.replace(/(^|-)([a-z])/g, (_, s, c) => `${s ? ' ' : ''}${c.toUpperCase()}`);

const files = {
  'package.json': {
    name: `@fbrx/plugin-${name}`,
    version: '0.1.0',
    private: true,
    description: `${title} — an FBRX OS plugin`,
    type: 'module',
    main: ts ? 'src/index.ts' : 'index.mjs',
    scripts: { 'pack:plugin': `node ../../scripts/pack-plugin.mjs .${ts ? ' --bundle' : ''}` },
    devDependencies: { '@fbrx/plugin-sdk': '1.0.0' },
  },
  'fbrx-plugin.json': {
    id,
    name: title,
    version: '0.1.0',
    description: `${title} tools for the FBRX OS agent.`,
    author: '',
    namespace,
    main: ts ? 'src/index.ts' : 'index.mjs',
    engines: { fbrx: '>=1.0.0' },
    // Least privilege: add "network:<host>", "secrets:<NAME>" or "notifications" only when a tool needs them.
    permissions: ['storage'],
  },
};

const body = `  async activate(ctx) {
    ctx.log.info(\`${title} \${ctx.plugin.version} ready\`);
  },

  tools: [
    {
      name: 'hello',
      title: 'Say hello',
      description: 'Greets someone and remembers how many greetings were sent. Replace this with your own tool.',
      risk: 'read', // read | write | network | execute | sensitive: drives the default approval policy
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Who to greet' } },
        required: ['name'],
      },
      async run({ name }, ctx) {
        const count = Number((await ctx.storage.get('greetings')) ?? 0) + 1;
        await ctx.storage.set('greetings', count);
        return { output: \`Hello, \${name}! (greeting #\${count})\`, data: { count } };
      },
    },
  ],
`;

const source = ts
  ? `import { definePlugin } from '@fbrx/plugin-sdk';

export default definePlugin({
${body}});
`
  : `// @ts-check
/** @typedef {import('@fbrx/plugin-sdk').PluginDefinition} PluginDefinition */

/** @type {PluginDefinition} */
export default {
${body}};
`;

mkdirSync(join(dir, ts ? 'src' : '.'), { recursive: true });
for (const [file, json] of Object.entries(files)) writeFileSync(join(dir, file), `${JSON.stringify(json, null, 2)}\n`);
writeFileSync(join(dir, ts ? 'src/index.ts' : 'index.mjs'), source);
writeFileSync(
  join(dir, 'README.md'),
  `# ${title}

An FBRX OS plugin. Its tools appear to the agent as \`${namespace}.<tool>\` and run in a sandboxed worker
that can only use the permissions declared in \`fbrx-plugin.json\`.

\`\`\`bash
npm run pack:plugin -w plugins/${name}   # → plugins/${name}/dist-plugin/${id}-0.1.0.tgz
\`\`\`

See docs/PLUGINS.md for the full SDK reference.
`,
);
console.log(`Created ${relative(process.cwd(), dir)} (${id}, namespace "${namespace}")`);
console.log('Run "npm install" once so the workspace links the plugin SDK types.');
