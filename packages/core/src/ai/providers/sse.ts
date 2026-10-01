/** Parses a `text/event-stream` body into `{event, data}` records. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));
        let event: string | null = null;
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

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
