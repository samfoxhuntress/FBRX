import { describe, expect, it } from 'vitest';
import { NOTIFY_LIMITS, systemTools } from '../src/tools/builtin/system-tools';

// Noah report 2.3.2, item 6: system.notify runs without asking, so it says who it is from and cannot flood the screen.
describe('system.notify', () => {
  it('starts every notification with the AI’s name and shows at most a few a minute and an hour', async () => {
    let t = 0;
    const shown: Array<[string, string]> = [];
    const notify = systemTools({ workspace: '/tmp', notify: (title, body) => shown.push([title, body]), agentName: () => 'Fabrix', now: () => t }).find((x) => x.name === 'system.notify')!;
    expect(notify.risk).toBe('read');
    const ctx = {} as never;
    expect((await notify.run({ title: 'Windows Security', body: 'Your computer is at risk' }, ctx)).output).toBe('Notification shown');
    await notify.run({ title: 'Fabrix: Backup done', body: 'All good' }, ctx);
    expect(shown).toEqual([
      ['Fabrix: Windows Security', 'Your computer is at risk'],
      ['Fabrix: Backup done', 'All good'],
    ]);

    // A minute's worth, then no more until the minute is over.
    await notify.run({ title: 'Three', body: '' }, ctx);
    expect((await notify.run({ title: 'Four', body: '' }, ctx)).output).toMatch(/^Not shown: .* Tell the person in the chat instead\.$/);
    expect(shown).toHaveLength(NOTIFY_LIMITS.perMinute);
    // An hour's worth across the minutes, then no more until the hour is over.
    for (let m = 1; shown.length < NOTIFY_LIMITS.perHour; m++) {
      t = m * 61_000;
      await notify.run({ title: `Minute ${m}`, body: '' }, ctx);
    }
    t += 61_000;
    expect((await notify.run({ title: 'Too many', body: '' }, ctx)).output).toMatch(/^Not shown/);
    t = 3_600_000 + 1;
    expect((await notify.run({ title: 'Later', body: '' }, ctx)).output).toBe('Notification shown');
  });
});
