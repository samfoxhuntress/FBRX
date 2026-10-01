// @ts-check
/** @typedef {import('@fbrx/plugin-sdk').PluginDefinition} PluginDefinition */
import { randomUUID } from 'node:crypto';

/** @type {PluginDefinition} */
export default {
  async activate(ctx) {
    ctx.log.info(`Example Toolkit ${ctx.plugin.version} activated`);
  },

  tools: [
    {
      name: 'text_stats',
      title: 'Text statistics',
      description: 'Count characters, words, lines and estimate reading time for a piece of text.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run({ text }) {
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        const stats = { characters: text.length, words, lines: text.split(/\r?\n/).length, readingMinutes: Math.max(1, Math.round(words / 230)) };
        return { output: Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('\n'), data: stats };
      },
    },
    {
      name: 'uuid',
      title: 'Generate IDs',
      description: 'Generate one or more random UUIDs.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 50, default: 1 } } },
      run({ count }) {
        const ids = Array.from({ length: count ?? 1 }, () => randomUUID());
        return { output: ids.join('\n'), data: ids };
      },
    },
    {
      name: 'counter',
      title: 'Persistent counter',
      description: 'Increment a named counter stored by the plugin and return its new value.',
      risk: 'write',
      inputSchema: { type: 'object', properties: { name: { type: 'string', default: 'default' }, by: { type: 'integer', default: 1 } } },
      async run({ name, by }, ctx) {
        const key = `counter:${name}`;
        const next = ((await ctx.storage.get(key)) ?? 0) + by;
        await ctx.storage.set(key, next);
        return { output: `${name} = ${next}`, data: { name, value: next } };
      },
    },
    {
      name: 'github_repo',
      title: 'GitHub repository info',
      description: 'Look up a public GitHub repository (stars, open issues, description). Uses GITHUB_TOKEN from the vault if present.',
      risk: 'network',
      inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' } }, required: ['repo'] },
      async run({ repo }, ctx) {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like owner/name');
        const token = await ctx.secrets.get('GITHUB_TOKEN').catch(() => undefined);
        const res = await ctx.http.fetch(`https://api.github.com/repos/${repo}`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'fbrx-os-example', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        });
        if (res.status !== 200) throw new Error(`GitHub returned ${res.status}`);
        const r = JSON.parse(res.body);
        return {
          output: `${r.full_name}: ${r.description ?? ''}\nstars ${r.stargazers_count}, open issues ${r.open_issues_count}, default branch ${r.default_branch}`,
          data: { stars: r.stargazers_count, issues: r.open_issues_count },
        };
      },
    },
  ],
};
