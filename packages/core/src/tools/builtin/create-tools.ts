import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { DOC_FORMATS, DOC_FORMAT_NAMES, IMAGE_SIZES, type CreatedFile, type DocFormat, type Settings } from '@fbrx/shared';
import type { ToolSpec } from '../types';
import type { DocumentRenderer } from '../../platform';
import type { OutputFolder } from '../../docs/output-folder';
import { parseMarkdown } from '../../docs/markdown';
import { renderHtml } from '../../docs/render-html';
import { renderDocx } from '../../docs/render-docx';
import { renderPdf } from '../../docs/render-pdf';
import { formatBytes } from '../../util/misc';
import { SCENE_BACKDROPS, SCENE_HOLD, SCENE_PARTS, SCENE_SHAPES, SCENE_WEAR, renderScene, sceneCatalog, type Scene } from '../../docs/scene';

export interface CreateToolDeps {
  output: OutputFolder;
  /** The app's browser engine (desktop): better PDFs, and PNG copies of drawings. */
  renderer: () => DocumentRenderer | null;
  images: () => Settings['ai']['images'];
  /** An AI provider's address and key for its images endpoint (governance applies as for chat). */
  imagesEndpoint: (providerId: string) => { baseUrl: string; apiKey: string | undefined };
}

/** Saves a file the agent made and describes it for the chat. */
async function save(path: string, data: Buffer | string, kind: CreatedFile['kind']): Promise<CreatedFile> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return { path, name: basename(path), kind, size: (await stat(path)).size };
}

const made = (files: CreatedFile[]) => files.map((f) => `${f.path} (${formatBytes(f.size)})`).join('\n');

/**
 * An SVG drawing with anything that could run or reach outside it removed: scripts, event handlers, embedded pages,
 * and links or style imports to other addresses (its own #references and embedded data: images stay). Null when it is
 * not an SVG drawing.
 */
export function cleanSvg(svg: string): string | null {
  const start = svg.search(/<svg[\s>]/i);
  const end = svg.lastIndexOf('</svg>');
  if (start < 0 || end < start) return null;
  let s = svg
    .slice(start, end + 6)
    .replace(/<script[\s\S]*?<\/script\s*>|<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*("|')(?!#|data:image\/)[^"']*\1/gi, '')
    .replace(/url\(\s*(['"]?)(?!#|data:image\/)[^)]*\1\s*\)/gi, 'none')
    .replace(/@import[^;]*;/gi, '');
  if (!/^<svg[^>]*\sxmlns=/i.test(s)) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

/** The size an SVG asks for (its viewBox, else width and height), scaled so the longer side is `long`. */
export function svgSize(svg: string, long: number): { width: number; height: number } {
  const tag = /^<svg[^>]*>/i.exec(svg)?.[0] ?? '';
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  const w = Number(vb?.[1] ?? /\swidth\s*=\s*["']?([\d.]+)/i.exec(tag)?.[1] ?? 1);
  const h = Number(vb?.[2] ?? /\sheight\s*=\s*["']?([\d.]+)/i.exec(tag)?.[1] ?? 1);
  const scale = long / Math.max(w, h, 1);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function createTools(d: CreateToolDeps): ToolSpec[] {
  /** A drawing saved as SVG, with a PNG copy where this computer can make one (that one comes first). */
  const drawing = async (name: string, svg: string, size = 1024) => {
    const files = [await save(d.output.newFile(name, 'svg', 'Pictures'), svg, 'image')];
    const renderer = d.renderer();
    if (renderer) {
      const { width, height } = svgSize(svg, size);
      const png = await renderer.rasterizeSvg(svg, width, height);
      files.unshift(await save(files[0].path.replace(/\.svg$/, '.png'), png, 'image'));
    }
    return files;
  };
  return [
    {
      name: 'docs.create',
      title: 'Create document',
      description:
        'Write a document and save it as a file the person can open: Markdown (md), plain text (txt), a web page (html), PDF (pdf), a .docx document (docx) or a CSV spreadsheet (csv). ' +
        'Write the content in Markdown (headings, lists, tables, bold, links) for md, html, pdf and docx; plain text for txt; comma-separated rows with a header row for csv. ' +
        'It is saved in the FBRX folder in Documents and never replaces an existing file. Tell the person its name; the chat shows it with an Open button.',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 120_000,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The title (also the file name)', maxLength: 200 },
          format: { type: 'string', enum: [...DOC_FORMATS] },
          content: { type: 'string', maxLength: 2_000_000 },
        },
        required: ['title', 'format', 'content'],
      },
      resources: () => ({ paths: [{ path: d.output.path(), access: 'write' }] }),
      async run(i) {
        const format = i.format as DocFormat;
        const title = String(i.title).trim() || 'Document';
        const path = d.output.newFile(title, format);
        const blocks = () => parseMarkdown(i.content);
        let data: Buffer | string;
        switch (format) {
          case 'md':
          case 'txt':
            data = i.content.endsWith('\n') ? i.content : `${i.content}\n`;
            break;
          case 'csv':
            // A byte-order mark so spreadsheet apps read accented letters right.
            data = `﻿${i.content.trim()}\r\n`.replace(/\r?\n/g, '\r\n');
            break;
          case 'html':
            data = renderHtml(title, blocks());
            break;
          case 'docx':
            data = renderDocx(title, blocks());
            break;
          case 'pdf': {
            const renderer = d.renderer();
            data = renderer ? await renderer.printPdf(renderHtml(title, blocks())) : renderPdf(title, blocks());
            break;
          }
        }
        const file = await save(path, data, 'document');
        return { output: `Saved "${title}" as ${DOC_FORMAT_NAMES[format]}:\n${made([file])}`, data: { files: [file] } };
      },
    },
    {
      name: 'image.draw',
      title: 'Draw picture',
      description:
        'Draw a picture as SVG vector art (icons, logos, diagrams, charts, maps, patterns) and save it, with a PNG copy, in the FBRX folder. For a scene with characters, animals, buildings or nature, use image.compose instead. ' +
        'Write one complete, self-contained <svg> with a viewBox, using shapes, paths, gradients and text; no scripts, no outside images or fonts. ' +
        'Work in layers: a background that fills the frame, then the large shapes, then details, with an outline on each shape, a lighter highlight and a darker shade, and three to six colors that go together.',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What to call the picture (the file name)', maxLength: 120 },
          svg: { type: 'string', maxLength: 1_000_000 },
          size: { type: 'integer', minimum: 64, maximum: 2048, default: 1024, description: 'Pixels along the longer side of the PNG copy' },
        },
        required: ['name', 'svg'],
      },
      resources: () => ({ paths: [{ path: d.output.path(), access: 'write' }] }),
      async run(i) {
        const svg = cleanSvg(i.svg);
        if (!svg) throw new Error('That is not an SVG drawing: send one complete <svg>…</svg>');
        const files = await drawing(i.name, svg, i.size);
        return { output: `Saved the drawing:\n${made(files)}`, data: { files } };
      },
    },
    {
      name: 'image.compose',
      title: 'Compose picture',
      description:
        "Make a storybook picture from FBRX's own art: a backdrop, then characters and scenery placed by name and position (x and y in percent; y is where its feet stand, about 86 on the ground and 20 in the sky), with names under them and a title. " +
        'No drawing needed: FBRX draws every piece, outlined and shaded. Characters can wear a hat or hood and hold up to two things; flip turns one to face left; color and accent recolor any piece. ' +
        `Saved as SVG with a PNG copy in the FBRX folder. ${sceneCatalog()}`,
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What to call the picture (the file name)', maxLength: 120 },
          backdrop: { type: 'string', enum: [...SCENE_BACKDROPS] },
          shape: { type: 'string', enum: Object.keys(SCENE_SHAPES), default: 'wide' },
          title: { type: 'string', maxLength: 80 },
          caption: { type: 'string', maxLength: 160 },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            items: {
              type: 'object',
              properties: {
                part: { type: 'string', enum: SCENE_PARTS },
                x: { type: 'number', minimum: 0, maximum: 100 },
                y: { type: 'number', minimum: 0, maximum: 100 },
                size: { type: 'number', minimum: 2, maximum: 100, description: 'Height in percent of the picture (a person about 30, a castle about 55)' },
                flip: { type: 'boolean' },
                color: { type: 'string', maxLength: 20, description: 'A color name (brown, mud, gold, navy…) or #rrggbb' },
                accent: { type: 'string', maxLength: 20 },
                wear: { type: 'string', enum: SCENE_WEAR },
                hold: { type: 'array', items: { type: 'string', enum: SCENE_HOLD }, maxItems: 2 },
                label: { type: 'string', maxLength: 40 },
              },
              required: ['part', 'x'],
            },
          },
          size: { type: 'integer', minimum: 256, maximum: 2048, default: 1600, description: 'Pixels along the longer side of the PNG copy' },
        },
        required: ['backdrop', 'items'],
      },
      resources: () => ({ paths: [{ path: d.output.path(), access: 'write' }] }),
      async run(i) {
        const svg = renderScene(i as Scene);
        const files = await drawing(i.name || i.title || 'Picture', svg, i.size ?? 1600);
        return { output: `Composed the picture:\n${made(files)}`, data: { files } };
      },
    },
    {
      name: 'image.generate',
      title: 'Make picture',
      description:
        'Make a picture (photo-like, painted or illustrated) from a detailed description with the picture maker set up in Settings, and save it as PNG in the FBRX folder. ' +
        'Describe the subject, setting, style, lighting and composition. For diagrams, icons and logos, draw them with image.draw instead.',
      risk: 'network',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 300_000,
      unavailable: () => (d.images().generator === 'draw' ? 'No picture maker is set up (Settings → Agent → Pictures); image.draw still works' : null),
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 4000 },
          name: { type: 'string', description: 'What to call the picture (the file name)', maxLength: 120 },
          size: { type: 'string', enum: [...IMAGE_SIZES], description: 'Square, wide or tall (default from Settings)' },
        },
        required: ['prompt'],
      },
      resources: () => ({ paths: [{ path: d.output.path(), access: 'write' }] }),
      async run(i, ctx) {
        const cfg = d.images();
        const size = (i.size ?? cfg.size) as string;
        const [width, height] = size.split('x').map(Number);
        const png = cfg.generator === 'txt2img' ? await txt2img(cfg.url, i.prompt, width, height, ctx.signal) : await imagesApi(d.imagesEndpoint(cfg.providerId), cfg.model, i.prompt, size, ctx.signal);
        const file = await save(d.output.newFile(i.name || i.prompt.slice(0, 60), 'png', 'Pictures'), png, 'image');
        return { output: `Made the picture:\n${made([file])}`, data: { files: [file] } };
      },
    },
  ];
}

async function jsonOrThrow(res: Response, what: string): Promise<any> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string; detail?: string };
  if (!res.ok) throw new Error(`${what} answered ${res.status}: ${typeof body.error === 'string' ? body.error : (body.error?.message ?? body.detail ?? 'no details')}`);
  return body;
}

/** An OpenAI-compatible images endpoint (POST <base>/images/generations). */
async function imagesApi(ep: { baseUrl: string; apiKey: string | undefined }, model: string, prompt: string, size: string, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch(`${ep.baseUrl.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
    // Newer image models always answer in base64 and refuse the response_format field.
    body: JSON.stringify({ model: model || undefined, prompt, size, n: 1, ...(/^gpt-image/.test(model) ? {} : { response_format: 'b64_json' }) }),
    signal,
  });
  const body = await jsonOrThrow(res, 'The picture maker');
  const item = body.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) return Buffer.from(await (await fetch(item.url, { signal })).arrayBuffer());
  throw new Error('The picture maker sent no picture');
}

/** A local image server's txt2img endpoint (POST <url>/sdapi/v1/txt2img). */
async function txt2img(url: string, prompt: string, width: number, height: number, signal: AbortSignal): Promise<Buffer> {
  if (!url) throw new Error('Enter the image server’s address in Settings → Agent → Pictures');
  const res = await fetch(`${url.replace(/\/+$/, '')}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, width, height, steps: 28 }),
    signal,
  });
  const body = await jsonOrThrow(res, 'The image server');
  if (!body.images?.[0]) throw new Error('The image server sent no picture');
  return Buffer.from(String(body.images[0]).replace(/^data:image\/\w+;base64,/, ''), 'base64');
}
