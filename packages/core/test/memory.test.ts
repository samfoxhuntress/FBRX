import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, findSensitive, scrubSensitive, type AgentEvent, type MemoryStatus } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';

const LOCAL_API = { origin: 'api' as const, actor: 'script' };

describe('What FBRX never keeps', () => {
  it('finds identity and money numbers by their shape and the words around them', () => {
    const kinds = (t: string) => findSensitive(t).map((f) => f.kind.id);
    expect(kinds('My social security number is 123-45-6789')).toContain('national-id');
    expect(kinds('ssn: 123456789')).toEqual(['national-id']);
    expect(kinds('why does my SSN start with 818 rather than 646?')).toEqual(['national-id']);
    expect(kinds("my driver's license is D1234567")).toEqual(['license']);
    expect(kinds('passport number X12345678')).toEqual(['passport']);
    expect(kinds('my routing number is 021000021 and account 1234567890')).toEqual(['bank', 'bank']);
    expect(kinds('IBAN DE89 3704 0044 0532 0130 00')).toEqual(['bank']);
    expect(kinds('my EIN is 12-3456789')).toEqual(['tax-id']);
    expect(kinds('card 4111 1111 1111 1111 cvv 123')).toEqual(['card', 'card']);
    expect(kinds('my password is hunter2!')).toEqual(['password']);
    // Not these: an order number, a phone number, an address, a date, a room.
    expect(kinds('order number 123456789 shipped; call 555-123-4567; 12 Oak St; 2024-05-01, room 4111')).toEqual([]);
    expect(scrubSensitive('pay with 4111 1111 1111 1111', { cardLast4: true }).text).toBe('pay with card ending 1111');
    expect(scrubSensitive('pay with 4111 1111 1111 1111').text).toBe('pay with [a full payment card number or its security code: never kept]');
  });
});

describe("The AI's memory of the person", () => {
  it('learns from what they say, never keeps identity numbers, and keeps private kinds only when allowed', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const m = kernel.memory;
      m.learn("My name is Jake Rivera and I live in Springfield. My address is 12 Oak St, Springfield. My social security number is 123-45-6789. I work at Fabrics Inc. My wife's name is Ana.");
      const all = m.list();
      expect(all.map((e) => e.content).sort()).toEqual(['Home address: 12 Oak St, Springfield', 'Lives in Springfield', 'Their name is Jake Rivera', 'Their wife is Ana', 'Works at Fabrics Inc'].sort());
      expect(all.find((e) => e.content.startsWith('Home address'))).toMatchObject({ category: 'address', private: true, source: 'auto' });
      // Nothing anywhere in the database holds the number.
      expect(JSON.stringify(kernel.db.all('SELECT * FROM memories'))).not.toContain('6789');

      // A newer fact replaces the older one with the same meaning.
      m.learn('I live in Shelbyville now, actually: I live in Shelbyville');
      expect(m.list().filter((e) => e.category === 'location').map((e) => e.content)).toEqual(['Lives in Shelbyville']);

      expect(() => m.remember({ content: 'SSN 123-45-6789', source: 'agent' })).toThrow(/never remembers/);
      expect(() => m.remember({ content: 'Jake’s Visa is 4111 1111 1111 1111', source: 'agent' })).toThrow(/payment cards is turned off/);
      kernel.settings.update({ memory: { keep: { payment: true } } });
      expect(m.remember({ content: 'Jake’s Visa is 4111 1111 1111 1111', source: 'agent' }).content).toBe('Jake’s Visa is card ending 1111');
      kernel.settings.update({ memory: { keep: { address: false } } });
      expect(() => m.remember({ content: 'Work address: 400 Main St, Suite 2', source: 'agent' })).toThrow(/address details is turned off/);

      // The person manages it in Settings → Memory (the person only).
      await expect(kernel.call('memory.add', { content: 'Prefers short answers' }, LOCAL_API)).rejects.toThrow();
      const added = (await kernel.call('memory.add', { content: 'Prefers short answers' }, USER)) as { id: string; category: string };
      expect(added.category).toBe('preference');
      const st = (await kernel.call('memory.status', undefined, USER)) as MemoryStatus;
      expect(st.neverKept.map((k) => k.id)).toContain('national-id');
      expect(await kernel.call('memory.forget', { id: added.id }, USER)).toEqual({ ok: true });
      expect(((await kernel.call('memory.forgetAll', undefined, USER)) as { forgotten: number }).forgotten).toBeGreaterThan(0);
      expect(m.list()).toEqual([]);

      // Turned off: nothing is learned.
      kernel.settings.update({ memory: { enabled: false } });
      expect(m.learn('My name is Jake')).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('tells a local AI everything it remembers, a cloud AI only general facts, and the last day only locally', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const m = kernel.memory;
      m.learn('My name is Jake. My address is 12 Oak St, Springfield. I work at Fabrics Inc.');
      const conv = kernel.conversations.create('Printer setup', 'user');
      kernel.conversations.append(conv.id, { role: 'user', content: 'How do I add the office printer?' });
      kernel.conversations.append(conv.id, { role: 'assistant', content: 'Open Settings, then Printers, then Add.' });

      const local = m.context({ conversationId: null, text: 'where do I live', cloud: false })!;
      expect(local).toContain('Home address: 12 Oak St, Springfield');
      expect(local).toContain('Their name is Jake');
      expect(local).toContain('Their last 24 hours');
      expect(local).toContain('Printer setup');

      const cloud = m.context({ conversationId: null, text: 'where do I live', cloud: true })!;
      expect(cloud).toContain('Their name is Jake');
      expect(cloud).toContain('Works at Fabrics Inc');
      expect(cloud).not.toContain('Oak St');
      expect(cloud).not.toContain('Printer setup');

      kernel.settings.update({ memory: { cloud: 'none' } });
      expect(m.context({ conversationId: null, text: 'x', cloud: true })).toBeNull();

      // A day later, the chat has left short-term memory (long-term chat search still finds it).
      expect(m.recent(null, Date.now() + 25 * 3600_000)).toEqual([]);
      expect(m.searchChats('office printer')[0]).toMatchObject({ title: 'Printer setup', role: 'user' });
    } finally {
      await cleanup();
    }
  });

  it('reaches whichever AI is chosen, with the person’s message (the instructions stay the same)', async () => {
    const { kernel, cleanup } = await makeKernel();
    let system = '';
    let message = '';
    const llm = await mockOpenAI((body) => {
      system = body.messages.find((x: any) => x.role === 'system')?.content ?? '';
      message = body.messages.findLast((x: any) => x.role === 'user')?.content ?? '';
      return { text: 'Hello Jake.' };
    });
    try {
      kernel.memory.learn('My name is Jake. My address is 12 Oak St, Springfield.');
      const provider = (cloud: boolean) => ({
        ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible' as const, name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud }] },
      });
      const ask = async (message: string) => {
        const events: AgentEvent[] = [];
        const off = kernel.events.on('agent', (e) => events.push(e));
        await kernel.call('ai.chat', { message }, USER);
        await waitFor(() => events.find((e) => e.type === 'run.completed' || e.type === 'run.failed'));
        off();
      };
      kernel.settings.update(provider(false));
      await ask('Hi! I work at Fabrics Inc.');
      expect(message).toContain('Their name is Jake');
      expect(message).toContain('12 Oak St');
      expect(system).not.toContain('Jake');
      // Learned from this very message.
      expect(kernel.memory.list().map((e) => e.content)).toContain('Works at Fabrics Inc');

      kernel.settings.update({ ...provider(true), policy: undefined } as never);
      kernel.policy.updateLocal({ ...kernel.policy.policy, ai: { ...kernel.policy.policy.ai, allowCloudProviders: true } });
      await ask('Hi again');
      expect(message).toContain('Their name is Jake');
      expect(message).not.toContain('12 Oak St');
      expect(system).not.toContain('Jake');
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});

describe('Nothing personal goes onto the internet', () => {
  it('blocks identity numbers outright, and asks before private details go out', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.memory.learn('My address is 12 Oak St, Springfield.');
      const web = kernel.registry.get('http.request')!;
      const ssn = kernel.guardian.reviewCall(web, { url: 'https://www.google.com/search?q=why+does+my+ssn+123-45-6789+start+with+123' }, { urls: ['https://www.google.com/search'] });
      expect(ssn).toContainEqual(expect.objectContaining({ severity: 'critical', code: 'personal-id-online' }));
      const partial = kernel.guardian.reviewCall(web, { url: 'https://www.google.com/search?q=Jake social security number starts with 818 meaning' }, { urls: ['https://www.google.com/search'] });
      expect(partial.map((f) => f.code)).toContain('personal-id-online');
      const address = kernel.guardian.reviewCall(web, { url: 'https://maps.example.com/?q=12 Oak St, Springfield' }, { urls: ['https://maps.example.com/'] });
      expect(address).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'private-online' }));
      const encoded = kernel.guardian.reviewCall(web, { url: 'https://maps.example.com/?q=12+Oak+St%2C+Springfield&ssn=123%2D45%2D6789' }, { urls: ['https://maps.example.com/'] });
      expect(encoded.map((f) => f.code).sort()).toEqual(['personal-id-online', 'private-online']);
      // A generic question is fine.
      expect(kernel.guardian.reviewCall(web, { url: 'https://www.google.com/search?q=what do social security area numbers mean' }, { urls: ['https://www.google.com/search'] })).toEqual([]);
      // On the computer itself (not online), the guard does not apply.
      expect(kernel.guardian.reviewCall(kernel.registry.get('fs.read_file')!, { path: '/tmp/ssn 123-45-6789.txt' }, {}).map((f) => f.code)).not.toContain('personal-id-online');

      // Through the gate, the agent's call is refused before anything is sent.
      const denied = await kernel.gate.invoke('http.request', { url: 'https://example.com/?q=123-45-6789' }, { origin: 'agent', actor: 'agent' });
      expect(denied.status).toBe('denied');
      expect(denied.output).toMatch(/Social Security/);
    } finally {
      await cleanup();
    }
  });
});
