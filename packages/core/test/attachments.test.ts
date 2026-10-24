import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, attachmentKind, modelSeesImages, type AgentEvent, type AttachmentInfo } from '@fbrx/shared';
import { zip } from '@fbrx/shared/node';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';

/** A one-pixel PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const docx = (body: string) =>
  zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>` },
  ]);

const para = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function chatWith(kernel: Awaited<ReturnType<typeof makeKernel>>['kernel'], url: string, model: string, message: string, attachments: string[]) {
  kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: model, providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${url}/v1`, cloud: false }] } });
  const events: AgentEvent[] = [];
  const off = kernel.events.on('agent', (e) => events.push(e));
  const r = (await kernel.call('ai.chat', { message, attachments }, USER)) as { conversationId: string };
  await waitFor(() => events.find((e) => e.type === 'run.completed' || e.type === 'run.failed'));
  off();
  return r.conversationId;
}

describe('attachments', () => {
  it('knows what kind of file it is and which models can see', () => {
    expect(attachmentKind('photo.JPG')).toBe('image');
    expect(attachmentKind('report.pdf')).toBe('document');
    expect(attachmentKind('data.csv')).toBe('text');
    expect(attachmentKind('archive.zip')).toBe('file');
    expect(modelSeesImages('anthropic', 'claude-opus-5-5')).toBe(true);
    expect(modelSeesImages('ollama', 'llava:13b')).toBe(true);
    expect(modelSeesImages('ollama', 'qwen2.5vl:7b')).toBe(true);
    expect(modelSeesImages('ollama', 'qwen2.5:7b')).toBe(false);
    expect(modelSeesImages('local-runtime', 'gemma-3-4b')).toBe(false);
  });

  it('reads text files and office documents into the message the AI gets, and keeps them with the chat', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ text: 'Read them.' }));
    try {
      const add = (name: string, data: Buffer) => kernel.call('ai.attachments.add', { name, data: data.toString('base64') }, USER) as Promise<AttachmentInfo>;
      const txt = await add('notes.txt', Buffer.from('Buy milk.\nCall Sam.'));
      expect(txt).toMatchObject({ kind: 'text', textChars: 19, note: null });
      expect(existsSync(txt.path)).toBe(true);
      const word = await add('Plan.docx', docx(para('Spring plan', 'Heading1') + para('Plant tomatoes &amp; basil.') + '<w:tbl><w:tr><w:tc>' + para('Week') + '</w:tc><w:tc>' + para('Job') + '</w:tc></w:tr></w:tbl>'));
      expect(word).toMatchObject({ kind: 'document' });
      const sheet = await add(
        'Budget.xlsx',
        zip([
          { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Money" sheetId="1" r:id="rId1"/></sheets></workbook>' },
          { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
          { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Rent</t></si><si><t>Food, drinks</t></si></sst>' },
          { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1200</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>300</v></c></row></sheetData></worksheet>' },
        ]),
      );
      expect(sheet).toMatchObject({ kind: 'document', pages: 1 });

      const conversationId = await chatWith(kernel, llm.url, 'mock-model', 'What is in these?', [txt.id, word.id, sheet.id]);
      const user = llm.requests.find((r) => r.body.messages)!.body.messages.find((m: any) => m.role === 'user');
      expect(user.content).toContain('What is in these?');
      expect(user.content).toContain('<attachment name="notes.txt" kind="text"');
      expect(user.content).toContain('Buy milk.');
      expect(user.content).toContain('# Spring plan\nPlant tomatoes & basil.');
      expect(user.content).toContain('| Week | Job |');
      expect(user.content).toContain('## Sheet: Money\nRent,1200\n"Food, drinks",,300');

      // The chat keeps what was attached; deleting the chat deletes the files.
      const msg = kernel.conversations.get(conversationId).messages[0];
      expect(msg.attachments?.map((a) => a.name)).toEqual(['notes.txt', 'Plan.docx', 'Budget.xlsx']);
      await kernel.call('ai.conversations.delete', { id: conversationId }, USER);
      await waitFor(() => !existsSync(txt.path));
      await expect(kernel.call('ai.attachments.read', { id: txt.id }, USER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('shows images to a model that can see, and tells one that cannot', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ text: 'A tiny picture.' }));
    try {
      const add = () => kernel.call('ai.attachments.add', { name: 'dot.png', data: PNG.toString('base64') }, USER) as Promise<AttachmentInfo>;
      const seen = await add();
      expect(seen).toMatchObject({ kind: 'image', mime: 'image/png' });
      await chatWith(kernel, llm.url, 'llava-mock', '', [seen.id]);
      const user = llm.requests.at(-1)!.body.messages.find((m: any) => m.role === 'user');
      expect(user.content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } });
      expect(user.content[1].text).toContain('Here are the attached files.');

      const unseen = await add();
      await chatWith(kernel, llm.url, 'text-only-model', 'What is this?', [unseen.id]);
      const plain = llm.requests.at(-1)!.body.messages.find((m: any) => m.role === 'user');
      expect(typeof plain.content).toBe('string');
      expect(plain.content).toContain('cannot see images');
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('removes an attachment that was not sent, and refuses files that are too big or missing', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const a = (await kernel.call('ai.attachments.add', { name: '../../evil:name.txt', data: Buffer.from('hi').toString('base64') }, USER)) as AttachmentInfo;
      expect(a.name).toBe('_.._evil_name.txt');
      expect((await kernel.call('ai.attachments.remove', { id: a.id }, USER)) as any).toEqual({ removed: true });
      expect(existsSync(a.path)).toBe(false);
      await expect(kernel.call('ai.attachments.add', { name: 'big.png', data: Buffer.alloc(6 * 1024 * 1024).toString('base64') }, USER)).rejects.toThrow(/make the picture smaller/);
      await expect(kernel.call('ai.chat', { message: 'hi', attachments: ['att_missing'] }, USER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Not from the Local API or the agent: a person attaches files.
      await expect(kernel.call('ai.attachments.add', { name: 'x.txt', data: 'aGk=' }, { origin: 'api', actor: 'script' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await cleanup();
    }
  });
});
