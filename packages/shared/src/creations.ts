/**
 * What the agent makes and reads for people: documents (Markdown, text, web pages, PDF, .docx, CSV), pictures (drawn
 * by the agent as vector art, or made from a description by a picture maker) and pages and searches on the web. What it
 * makes is saved in the output folder (Settings → Agent → Files) and shown in the chat under the step that made it.
 */

export const DOC_FORMATS = ['md', 'txt', 'html', 'pdf', 'docx', 'csv'] as const;
export type DocFormat = (typeof DOC_FORMATS)[number];
export const DOC_FORMAT_NAMES: Record<DocFormat, string> = { md: 'Markdown', txt: 'Text', html: 'Web page', pdf: 'PDF', docx: 'Document (.docx)', csv: 'Spreadsheet (CSV)' };

/**
 * How pictures are made from a description: draw (the agent draws them itself as vector art; nothing to set up, works
 * offline), images-api (an AI provider's OpenAI-compatible images endpoint) or txt2img (a local image server's txt2img
 * endpoint).
 */
export const IMAGE_GENERATORS = ['draw', 'images-api', 'txt2img'] as const;
export type ImageGenerator = (typeof IMAGE_GENERATORS)[number];
export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/** Where the agent searches the web: a public search page (no account) or your own SearXNG server. */
export const WEB_SEARCH_ENGINES = ['public', 'searxng'] as const;
export type WebSearchEngine = (typeof WEB_SEARCH_ENGINES)[number];

/** Where what the agent makes is saved unless someone picks another folder. */
export const DEFAULT_OUTPUT_FOLDER = '${DOCUMENTS}/FBRX';

/** A file a tool made, shown in the chat under the step that made it. */
export interface CreatedFile {
  path: string;
  name: string;
  kind: 'image' | 'document';
  size: number;
}

/** File types the app shows as pictures. */
export const PICTURE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
