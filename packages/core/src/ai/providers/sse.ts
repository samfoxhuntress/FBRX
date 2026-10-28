export { parseSse } from '@fbrx/shared';

/** Parses newline-delimited JSON (Ollama streaming). */
export async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line);
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer.trim());
  } finally {
    reader.releaseLock();
  }
}
