import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockLlm {
  url: string;
  requests: any[];
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  res.end();
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void): Promise<{ server: Server; url: string; requests: any[] }> {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : {};
    requests.push({ path: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

/**
 * OpenAI-compatible chat server (what llama.cpp's llama-server, LM Studio and vLLM expose).
 * `script(body)` decides each turn: a tool call or a final text answer.
 */
export async function mockOpenAI(script: (body: any, turn: number) => { tool?: { name: string; args: unknown }; text?: string }): Promise<MockLlm> {
  let turn = 0;
  const { server, url, requests } = await listen((req, res, body) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    const step = script(body, turn++);
    const events: Array<{ data: unknown }> = [];
    if (step.tool) {
      const args = JSON.stringify(step.tool.args);
      const half = Math.floor(args.length / 2);
      events.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: step.tool.name, arguments: args.slice(0, half) } }] } }] } });
      events.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] } });
      events.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } });
    } else {
      for (const word of (step.text ?? '').split(/(?<= )/)) events.push({ data: { choices: [{ index: 0, delta: { content: word } }] } });
      events.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
    }
    events.push({ data: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } } });
    events.push({ data: '[DONE]' });
    sse(res, events);
  });
  return { url, requests, close: () => new Promise((r) => server.close(() => r())) };
}

/** Anthropic Messages API (streaming) mock. */
export async function mockAnthropic(script: (body: any, turn: number) => { tool?: { name: string; args: unknown }; text?: string; refusal?: boolean }): Promise<MockLlm> {
  let turn = 0;
  const { server, url, requests } = await listen((req, res, body) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: null, last_id: null }));
      return;
    }
    const step = script(body, turn++);
    const msg = { id: `msg_${turn}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } };
    const events: Array<{ event: string; data: unknown }> = [{ event: 'message_start', data: { type: 'message_start', message: msg } }];
    let idx = 0;
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } } });
    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: `sig-${turn}` } } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx++ } });
    let stop = 'end_turn';
    if (step.refusal) {
      stop = 'refusal';
    } else if (step.tool) {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: `toolu_${turn}`, name: step.tool.name, input: {} } } });
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.args) } } });
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx++ } });
      stop = 'tool_use';
    } else {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } } });
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: step.text ?? '' } } });
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx++ } });
    }
    events.push({
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, ...(step.refusal ? { stop_details: { type: 'refusal', category: 'cyber', explanation: 'test refusal' } } : {}) }, usage: { output_tokens: 30 } },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    sse(res, events);
  });
  return { url, requests, close: () => new Promise((r) => server.close(() => r())) };
}
