import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, type AgentEvent, type CreatedFile } from '@fbrx/shared';
import { parseMarkdown, inlineText } from '../src/docs/markdown';
import { extractText } from '../src/docs/extract';
import { cleanSvg, svgSize } from '../src/tools/builtin/create-tools';
import { publicResults, quoteSymbol, webTools } from '../src/tools/builtin/web-tools';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A local web server answering each path with what `routes` gives it. */
async function serve(routes: (path: string, body: any) => { type?: string; body: string | Buffer; status?: number }): Promise<{ url: string; requests: Array<{ path: string; body: any }>; close: () => Promise<void> }> {
  const requests: Array<{ path: string; body: any }> = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    requests.push({ path: req.url ?? '', body });
    const r = routes(req.url ?? '', body);
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/json' }).end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

const invoke = (kernel: Awaited<ReturnType<typeof makeKernel>>['kernel'], name: string, input: unknown) => kernel.call('tools.invoke', { name, input }, USER) as Promise<{ ok: boolean; output: string; data: { files: CreatedFile[] }; error?: string }>;

describe('what the agent makes', () => {
  it('reads the Markdown agents write: nested lists, tables, code, quotes and inline styles', () => {
    const blocks = parseMarkdown('# Plan\n\nSome **bold**, *italic*, `code` and [a link](https://x.example).\n\n- one\n- two\n  - two and a half\n1. first\n2. second\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```\n\n> said\n\n---');
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'para', 'list', 'list', 'table', 'code', 'quote', 'hr']);
    const para = blocks[1] as Extract<(typeof blocks)[number], { t: 'para' }>;
    expect(para.c.map((x) => x.t)).toEqual(['text', 'bold', 'text', 'italic', 'text', 'code', 'text', 'link', 'text']);
    expect(inlineText(para.c)).toBe('Some bold, italic, code and a link.');
    const bullets = blocks[2] as Extract<(typeof blocks)[number], { t: 'list' }>;
    expect(bullets.items[1].map((b) => b.t)).toEqual(['para', 'list']);
    const table = blocks[4] as Extract<(typeof blocks)[number], { t: 'table' }>;
    expect(table.align).toEqual(['left', 'right']);
    expect(blocks[5]).toEqual({ t: 'code', lang: 'js', v: 'let x = 1;' });
  });

  it('writes documents in every format, each into a new file, where the AI may write', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { outputFolder: join(sandbox, 'Made') } });
      expect(await kernel.call('ai.files.folder', {}, USER)).toEqual({ path: join(sandbox, 'Made'), chosen: join(sandbox, 'Made'), allowed: true });
      const content = '# Q3 report\n\nRevenue **grew**.\n\n| Region | Sales |\n| --- | ---: |\n| North | 12 |';
      const made: Record<string, CreatedFile> = {};
      for (const format of ['md', 'txt', 'html', 'pdf', 'docx'] as const) {
        const r = await invoke(kernel, 'docs.create', { title: 'Q3 report', format, content });
        expect(r.ok).toBe(true);
        made[format] = r.data.files[0];
        expect(made[format]).toMatchObject({ name: `Q3 report.${format}`, kind: 'document' });
        expect(existsSync(made[format].path)).toBe(true);
      }
      expect(readFileSync(made.md.path, 'utf8')).toBe(`${content}\n`);
      expect(readFileSync(made.html.path, 'utf8')).toMatch(/<h1>Q3 report<\/h1>[\s\S]*<strong>grew<\/strong>[\s\S]*<td style="text-align:right">12<\/td>/);
      // Without the app's browser engine (a server), FBRX writes the PDF itself.
      expect((await extractText('a.pdf', 'document', readFileSync(made.pdf.path))).text).toContain('Revenue grew.');
      expect((await extractText('a.docx', 'document', readFileSync(made.docx.path))).text).toBe('# Q3 report\nRevenue grew.\n| Region | Sales |\n| North | 12 |');
      const csv = await invoke(kernel, 'docs.create', { title: 'Sales', format: 'csv', content: 'Region,Sales\nNorth,12' });
      expect(readFileSync(csv.data.files[0].path, 'utf8')).toBe('﻿Region,Sales\r\nNorth,12\r\n');
      // The same title again: a new file, the first one untouched.
      expect((await invoke(kernel, 'docs.create', { title: 'Q3 report', format: 'md', content: 'v2' })).data.files[0].name).toBe('Q3 report (2).md');
      expect(readFileSync(made.md.path, 'utf8')).toBe(`${content}\n`);
      // A folder the AI may not write in: what it makes goes into the workspace instead.
      kernel.settings.update({ ai: { outputFolder: join(sandbox, '..', 'elsewhere') } });
      const folder = (await kernel.call('ai.files.folder', {}, USER)) as { path: string; allowed: boolean };
      expect(folder).toMatchObject({ allowed: false, path: join(kernel.paths.workspace, 'Documents') });
      expect((await invoke(kernel, 'docs.create', { title: 'Note', format: 'txt', content: 'hi' })).data.files[0].path).toBe(join(kernel.paths.workspace, 'Documents', 'Note.txt'));
    } finally {
      await cleanup();
    }
  });

  it('shows what a step made under it in the chat', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI((_b, turn) => (turn === 0 ? { tool: { name: 'docs__create', args: { title: 'Shopping list', format: 'md', content: '- milk' } } } : { text: 'Saved your list.' }));
    try {
      kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
      const events: AgentEvent[] = [];
      kernel.events.on('agent', (e) => events.push(e));
      // Writing a new file in the FBRX folder needs no approval (builtin-documents).
      const { conversationId } = (await kernel.call('ai.chat', { message: 'Make me a shopping list' }, USER)) as { conversationId: string };
      await waitFor(() => events.find((e) => e.type === 'run.completed'));
      const call = kernel.conversations.get(conversationId).messages[1].toolCalls![0];
      expect(call).toMatchObject({ name: 'docs.create', status: 'succeeded', files: [{ name: 'Shopping list.md', kind: 'document' }] });
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('draws pictures as clean SVG, and shows only its own pictures', async () => {
    expect(cleanSvg('<p>no</p>')).toBeNull();
    const dirty = cleanSvg('<?xml version="1.0"?><svg viewBox="0 0 200 100" onload="alert(1)"><script>alert(2)</script><image href="https://evil.example/x.png"/><rect fill="url(#g)" style="fill:url(https://evil.example/f)"/><foreignObject><p>hi</p></foreignObject></svg>')!;
    expect(dirty).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><image/><rect fill="url(#g)" style="fill:none"/></svg>');
    expect(svgSize(dirty, 1024)).toEqual({ width: 1024, height: 512 });
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { outputFolder: join(sandbox, 'Made') } });
      const r = await invoke(kernel, 'image.draw', { name: 'Sun', svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="gold"/></svg>' });
      // Without the app's browser engine there is no PNG copy, only the drawing.
      expect(r.data.files).toEqual([expect.objectContaining({ name: 'Sun.svg', kind: 'image', path: join(sandbox, 'Made', 'Pictures', 'Sun.svg') })]);
      expect(await kernel.call('ai.files.preview', { path: r.data.files[0].path }, USER)).toMatchObject({ mime: 'image/svg+xml' });
      await expect(kernel.call('ai.files.preview', { path: join(sandbox, '..', 'other.png') }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(kernel.call('ai.files.preview', { path: r.data.files[0].path }, { origin: 'api', actor: 'script' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await cleanup();
    }
  });

  it('makes pictures with a picture maker once one is set up', async () => {
    const server = await serve((path) => (path === '/sdapi/v1/txt2img' ? { body: JSON.stringify({ images: [PNG.toString('base64')] }) } : { body: JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) }));
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { outputFolder: join(sandbox, 'Made') } });
      expect(kernel.registry.get('image.generate')!.unavailable!()).toMatch(/No picture maker/);
      kernel.settings.update({ ai: { images: { generator: 'txt2img', url: server.url, size: '1536x1024' } } });
      expect(kernel.registry.get('image.generate')!.unavailable!()).toBeNull();
      const local = await invoke(kernel, 'image.generate', { prompt: 'A lighthouse at dusk', name: 'Lighthouse' });
      expect(local.data.files[0]).toMatchObject({ name: 'Lighthouse.png', kind: 'image' });
      expect(readFileSync(local.data.files[0].path)).toEqual(PNG);
      expect(server.requests.at(-1)).toMatchObject({ path: '/sdapi/v1/txt2img', body: { prompt: 'A lighthouse at dusk', width: 1536, height: 1024 } });

      kernel.settings.update({
        ai: {
          providers: [...DEFAULT_PROVIDERS, { id: 'pics', type: 'openai-compatible', name: 'Pictures', enabled: true, baseUrl: `${server.url}/v1`, cloud: false }],
          images: { generator: 'images-api', providerId: 'pics', model: 'pic-1', size: '1024x1024' },
        },
      });
      const cloud = await invoke(kernel, 'image.generate', { prompt: 'A red bicycle' });
      expect(cloud.data.files[0].name).toBe('A red bicycle.png');
      expect(server.requests.at(-1)).toMatchObject({ path: '/v1/images/generations', body: { model: 'pic-1', prompt: 'A red bicycle', size: '1024x1024', n: 1, response_format: 'b64_json' } });
    } finally {
      await server.close();
      await cleanup();
    }
  });

  it('reads web pages with their links, and reads search results and quotes', async () => {
    const page = `<html><head><title>Bikes for sale</title><script>var x=1</script></head><body><h1>Listings</h1><p>Road bike &amp; helmet, $250</p><a href="/item/1">Road bike</a> <a href="#top">Top</a> <a href="https://other.example/2">Cargo bike</a></body></html>`;
    const server = await serve((path) => (path === '/list' ? { type: 'text/html; charset=utf-8', body: page } : { status: 404, body: '{}' }));
    try {
      const read = webTools({ checkUrl: async () => ({ ok: true }), search: () => ({ engine: 'public', url: '' }), appVersion: '2.0.0' }).find((t) => t.name === 'web.read')!;
      const r = await read.run({ url: `${server.url}/list` }, { callId: 'c', origin: 'agent', actor: 'test', runId: null, signal: new AbortController().signal });
      expect(r.output).toContain('Bikes for sale');
      expect(r.output).toContain('Road bike & helmet, $250');
      expect(r.output).not.toContain('var x');
      expect(r.output).toContain(`[1] Road bike — ${server.url}/item/1\n[2] Cargo bike — https://other.example/2`);
      await expect(read.run({ url: `${server.url}/gone` }, { callId: 'c', origin: 'agent', actor: 'test', runId: null, signal: new AbortController().signal })).rejects.toThrow(/answered 404/);
    } finally {
      await server.close();
    }

    const results = publicResults(
      `<div class="result result--ad"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>` +
        `<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbikes&amp;rut=x">Used <b>bikes</b></a></h2><a class="result__snippet" href="#">Cheap &amp; cheerful</a></div>` +
        `<div class="result"><a href="https://shop.example/" class="result__a">Bike shop</a></div>`,
    );
    expect(results).toEqual([
      { title: 'Used bikes', url: 'https://example.com/bikes', snippet: 'Cheap & cheerful' },
      { title: 'Bike shop', url: 'https://shop.example/', snippet: '' },
    ]);
    expect(['AAPL', 'brk.b', '^SPX', 'EURUSD', 'VOD.UK', '7203.JP'].map(quoteSymbol)).toEqual(['aapl.us', 'brk-b.us', '^spx', 'eurusd', 'vod.uk', '7203.jp']);
  });
});
