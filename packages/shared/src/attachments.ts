/**
 * Files and images attached to a message for the AI. They are kept in FBRX's workspace (Attachments, one folder per
 * file) so the AI's file tools can open them too, and go with their chat when it is deleted. Text is read out of
 * documents when they are attached; images go to AI models that can see them.
 */

/** The largest file that can be attached. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** The largest image an AI model takes (the app shrinks bigger photos before attaching them). */
export const IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** The longest side an attached image is shrunk to. */
export const IMAGE_ATTACHMENT_MAX_SIDE = 2000;
export const ATTACHMENTS_PER_MESSAGE = 10;

/**
 * image: shown to models that can see; text: plain text, code, data (read as it is); document: PDF and office
 * documents (their text is read out); file: anything else (the AI gets its name, size and where it is).
 */
export type AttachmentKind = 'image' | 'text' | 'document' | 'file';

export interface AttachmentInfo {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  /** Where the file is, inside FBRX's workspace. */
  path: string;
  /** How much text was read out of it (text files and documents), or null. */
  textChars: number | null;
  /** Pages (PDF), slides (presentations) or sheets (spreadsheets), when it has them. */
  pages: number | null;
  /** Why no text came out of it (a scanned PDF, a protected document), shown with the file. */
  note: string | null;
}

/** Image types AI models take. */
export const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** Extensions read as plain text (besides anything whose type is text/*). */
export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'html', 'htm', 'css', 'svg', 'rtf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sql', 'sh', 'bash', 'zsh',
  'ps1', 'psm1', 'bat', 'cmd', 'r', 'lua', 'pl', 'scala', 'dart', 'vue', 'svelte', 'tex', 'srt', 'vtt', 'env', 'properties', 'gradle', 'dockerfile',
]);

/** Documents whose text FBRX reads out. */
export const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);

/** A file's extension, lowercased, without the dot ("" when it has none). */
export function fileExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** What kind of attachment a file is, from its name and type. */
export function attachmentKind(name: string, mime = ''): AttachmentKind {
  const ext = fileExtension(name);
  if (IMAGE_MIME[ext] || /^image\/(png|jpeg|gif|webp)$/.test(mime)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || /json|xml|yaml|javascript/.test(mime)) return 'text';
  return 'file';
}

/** Model names that take images, whoever serves them (a best guess from the name). */
const SEEING_MODELS =
  /(vision|[-_.]vl\b|\bvl[-_]|llava|pixtral|gemma-?3|qwen[\d.]*-?vl|minicpm-?v|moondream|llama-?3\.2-?vision|llama-?4|granite[\w.-]*vision|internvl|smolvlm|phi-?(3\.5|4)-?(vision|multimodal)|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|\bo[34](-|$)|claude|gemini|mistral-(small-3\.[12]|medium-3))/i;

/**
 * Whether an AI model can look at images. Claude models all can; FBRX's built-in runtime runs text models only; for
 * other servers it is judged from the model's name.
 */
export function modelSeesImages(providerType: string, model: string): boolean {
  if (providerType === 'anthropic') return true;
  // Pictures are not sent to another computer's AI: they would not fit through FBRX Mesh.
  if (providerType === 'local-runtime' || providerType === 'mesh') return false;
  return SEEING_MODELS.test(model);
}
