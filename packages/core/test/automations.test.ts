import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, describeAutomationSchedule, nextAutomationRun, type Automation, type NotificationEvent } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import type { Kernel } from '../src/kernel';
import { mockOpenAI } from './mock-llm';

const listings = { name: 'New bikes', prompt: 'List new road bikes under $500 at https://ads.example/bikes', schedule: { kind: 'interval' as const, minutes: 60 }, notify: 'changes' as const, online: true, hotkey: '', enabled: true };

/** A cloud model is shown every tool it may use (a local one gets a short list), so its request shows what a run may use. */
function useCloudMock(kernel: Kernel, url: string) {
  kernel.policy.updateLocal({ ...kernel.policy.policy, ai: { ...kernel.policy.policy.ai, allowCloudProviders: true } });
  kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${url}/v1`, cloud: true }] } });
}

describe('automations', () => {
  it('says when they run, and works out the next run', () => {
    expect(describeAutomationSchedule({ kind: 'interval', minutes: 60 })).toBe('Every hour');
    expect(describeAutomationSchedule({ kind: 'interval', minutes: 90 })).toBe('Every 90 minutes');
    expect(describeAutomationSchedule({ kind: 'daily', time: '07:30', days: [1, 2, 3, 4, 5] })).toBe('Weekdays at 7:30 AM');
    expect(describeAutomationSchedule({ kind: 'daily', time: '16:00', days: [5] })).toBe('Fri at 4:00 PM');
    expect(describeAutomationSchedule({ kind: 'start' })).toBe('When FBRX starts');

    const friday = new Date(2026, 9, 23, 17, 0); // a Friday, 5 PM
    expect(nextAutomationRun({ kind: 'daily', time: '07:30', days: [1, 2, 3, 4, 5] }, friday, null)).toEqual(new Date(2026, 9, 26, 7, 30));
    expect(nextAutomationRun({ kind: 'daily', time: '18:00', days: [] }, friday, null)).toEqual(new Date(2026, 9, 23, 18, 0));
    // An interval runs at once the first time, then counts from the last run; a run long overdue goes now.
    expect(nextAutomationRun({ kind: 'interval', minutes: 60 }, friday, null)).toEqual(friday);
    expect(nextAutomationRun({ kind: 'interval', minutes: 60 }, friday, new Date(2026, 9, 23, 16, 30))).toEqual(new Date(2026, 9, 23, 17, 30));
    expect(nextAutomationRun({ kind: 'interval', minutes: 60 }, friday, new Date(2026, 9, 22, 9, 0))).toEqual(friday);
    expect(nextAutomationRun({ kind: 'manual' }, friday, null)).toBeNull();
  });

  it('runs unattended in its own chat, and tells only when something changed', async () => {
    const { kernel, cleanup } = await makeKernel();
    const answers = ['Two new bikes: a Trek for $420 and a Giant for $380.', 'NO_CHANGE', 'One more: a Cannondale for $450.'];
    let calls = 0;
    const llm = await mockOpenAI(() => ({ text: answers[calls++] }));
    try {
      useCloudMock(kernel, llm.url);
      const told: NotificationEvent[] = [];
      kernel.events.on('notification', (n) => told.push(n));
      const created = (await kernel.call('automations.create', { ...listings, schedule: { kind: 'manual' } }, USER)) as Automation;
      expect(created).toMatchObject({ name: 'New bikes', nextRunAt: null, running: false, lastRun: null, conversationId: null });
      const run = async () => {
        await kernel.call('automations.run', { id: created.id }, USER);
        return waitFor(() => {
          const a = kernel.automations.get(created.id);
          return !a.running && a.lastRun?.status !== 'running' ? a : null;
        });
      };

      const first = await run();
      expect(first.lastRun).toMatchObject({ status: 'done', changed: true, trigger: 'manual', summary: 'Two new bikes: a Trek for $420 and a Giant for $380.' });
      expect(told.at(-1)).toMatchObject({ title: 'New bikes', source: 'automation', open: `agent/chat/${first.conversationId}` });
      // Nobody is there to approve: tools that would ask are left out; new files and web reading stay.
      const tools = (llm.requests.find((r) => r.body.messages)!.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
      expect(tools).toEqual(expect.arrayContaining(['web__read', 'docs__create']));
      expect(tools).not.toContain('fs__write_file');
      expect(tools).not.toContain('shell__run');
      // Its standing instructions go to the agent, not into the chat.
      const [system, ...rest] = llm.requests.at(-1)!.body.messages;
      expect(system.content).toContain('answer with exactly NO_CHANGE');
      expect(rest.at(-1).content).toBe(listings.prompt);

      const second = await run();
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.lastRun).toMatchObject({ status: 'done', changed: false, summary: 'Nothing new.' });
      expect(told).toHaveLength(1);

      // The person deleted its chat: the next run starts a new one.
      await kernel.call('ai.conversations.delete', { id: first.conversationId }, USER);
      const third = await run();
      expect(third.conversationId).not.toBe(first.conversationId);
      expect(third.lastRun).toMatchObject({ changed: true });
      expect(told).toHaveLength(2);
      expect((await kernel.call('automations.runs', { id: created.id }, USER)) as unknown[]).toHaveLength(3);
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('runs what is due on schedule, keeps offline ones off the internet, and refuses a taken shortcut', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ text: 'Done.' }));
    try {
      useCloudMock(kernel, llm.url);
      await expect(kernel.call('automations.create', { ...listings, hotkey: kernel.settings.get().spotlight.hotkey }, USER)).rejects.toMatchObject({ code: 'CONFLICT' });
      const a = (await kernel.call('automations.create', { ...listings, name: 'Report', online: false, notify: 'never' }, USER)) as Automation;
      expect(Date.parse(a.nextRunAt!)).toBeLessThanOrEqual(Date.now());
      kernel.automations.tick();
      const done = await waitFor(() => (kernel.automations.get(a.id).lastRun?.status === 'done' ? kernel.automations.get(a.id) : null));
      expect(done.lastRun!.trigger).toBe('schedule');
      // The next run is an hour after this one started.
      expect(Date.parse(done.nextRunAt!) - Date.parse(done.lastRun!.startedAt)).toBe(3_600_000);
      const tools = (llm.requests.find((r) => r.body.messages)!.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
      expect(tools).not.toContain('web__read');
      expect(tools).toContain('docs__create');
      // Turned off: no next run.
      expect((await kernel.call('automations.update', { id: a.id, enabled: false }, USER)) as Automation).toMatchObject({ enabled: false, nextRunAt: null });
      expect((await kernel.call('automations.remove', { id: a.id }, USER)) as object).toEqual({ removed: true });
      expect(kernel.automations.list()).toEqual([]);
      // Only a person sets them up.
      await expect(kernel.call('automations.create', listings, { origin: 'api', actor: 'script' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});
