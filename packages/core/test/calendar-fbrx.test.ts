import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_LINK_COLORS, type CalendarEvent, type NotificationEvent } from '@fbrx/shared';
import { makeKernel, USER } from './helpers';
import type { Kernel } from '../src/kernel';

let kernel: Kernel;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ kernel, cleanup } = await makeKernel()));
afterEach(async () => cleanup());

/** Local times, so the tests read the way the calendar is used (March 1st, 2027 is a Monday). */
const at = (d: string, t = '00:00') => new Date(`${d}T${t}`);
const create = (p: Record<string, unknown>) => kernel.call('calendar.create', p, USER) as Promise<CalendarEvent>;
const between = (from: string, to: string) => kernel.calendar.events(at(from), at(to));
const mine = (list: CalendarEvent[]) => list.filter((e) => e.calendarId === 'events');

describe('The FBRX calendar', () => {
  it('keeps events here, and repeats them by day, weekday, week, month and year', async () => {
    const standup = await create({ title: 'Standup', start: at('2027-03-01', '09:00').toISOString(), durationMinutes: 15, repeat: 'weekdays', repeatUntil: '2027-03-12' });
    expect(standup).toMatchObject({ accountId: 'fbrx', calendarId: 'events', accountName: 'FBRX', repeat: 'weekdays', madeBy: 'person', canEdit: true, canDelete: true, link: null });
    const days = mine(between('2027-02-28', '2027-03-20')).filter((e) => e.series === standup.series);
    // Two working weeks, no weekends, and the same time of day throughout.
    expect(days.map((e) => new Date(e.start).getDate())).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 11, 12]);
    expect(new Set(days.map((e) => new Date(e.start).getHours()))).toEqual(new Set([9]));
    expect(new Set(days.map((e) => e.id)).size).toBe(10);

    // The 31st skips the months without one; all-day events cover whole days.
    const rent = await create({ title: 'Rent', start: '2027-01-31', repeat: 'monthly' });
    expect(rent.allDay).toBe(true);
    expect(mine(between('2027-01-01', '2027-06-01')).filter((e) => e.title === 'Rent').map((e) => e.start.slice(0, 7))).toEqual(
      ['2027-01-31', '2027-03-31', '2027-05-31'].map((d) => at(d).toISOString().slice(0, 7)),
    );
    // A weekly event that started long ago shows where the window is.
    await create({ title: 'Choir', start: at('2024-03-04', '19:00').toISOString(), end: at('2024-03-04', '20:30').toISOString(), repeat: 'weekly' });
    expect(mine(between('2027-03-01', '2027-03-15')).filter((e) => e.title === 'Choir').map((e) => new Date(e.start).getDate())).toEqual([1, 8]);
    // Through the API the week view asks for: a week at a time.
    const week = (await kernel.call('calendar.events', { from: at('2027-03-08').toISOString(), to: at('2027-03-15').toISOString() }, USER)) as CalendarEvent[];
    expect(week.filter((e) => e.title === 'Standup')).toHaveLength(5);
  });

  it('colors each event by what it is about', async () => {
    const project = kernel.workspace.saveProject({ name: 'Garden', color: '#22c55e', due: '2027-03-05' });
    const note = kernel.workspace.saveNote({ title: 'Seeds to buy', projectId: project.id });
    const loose = kernel.workspace.saveNote({ title: 'Ideas' });
    const task = kernel.workspace.saveTask({ title: 'Order soil', due: '2027-03-03', projectId: project.id });
    const auto = kernel.automations.create({ name: 'Morning brief', prompt: 'Brief me', schedule: { kind: 'daily', time: '07:30', days: [1, 2, 3, 4, 5] }, notify: 'always', online: false, hotkey: '', enabled: true }, 'test');
    const day = (d: string) => ({ start: at('2027-03-02', '10:00').toISOString().replace('03-02', d) });
    const byProject = await create({ title: 'Plant', ...day('03-02'), link: { kind: 'project', id: project.id } });
    const byNote = await create({ title: 'Shop', ...day('03-02'), link: { kind: 'note', id: note.id } });
    const byLooseNote = await create({ title: 'Think', ...day('03-02'), link: { kind: 'note', id: loose.id } });
    const byAuto = await create({ title: 'Read the brief', ...day('03-02'), link: { kind: 'automation', id: auto.id } });
    const own = await create({ title: 'Mine', ...day('03-02'), link: { kind: 'project', id: project.id }, color: '#ef4444' });
    const plain = await create({ title: 'Plain', ...day('03-02') });

    expect(byProject).toMatchObject({ color: '#22c55e', link: { kind: 'project', name: 'Garden', project: { id: project.id, color: '#22c55e' } } });
    expect(byNote).toMatchObject({ color: '#22c55e', link: { kind: 'note', name: 'Seeds to buy', project: { name: 'Garden' } } });
    expect(byLooseNote).toMatchObject({ color: CALENDAR_LINK_COLORS.note, link: { kind: 'note', project: null } });
    expect(byAuto).toMatchObject({ color: CALENDAR_LINK_COLORS.automation, link: { kind: 'automation', name: 'Morning brief' } });
    expect(own).toMatchObject({ color: '#ef4444', ownColor: '#ef4444' });
    expect(plain.color).toBe(kernel.calendar.accounts().find((a) => a.id === 'fbrx')!.color);
    await expect(create({ title: 'Gone', ...day('03-02'), link: { kind: 'task', id: 'nope' } })).rejects.toThrow(/not there any more/);

    // What FBRX knows from elsewhere: the task and the project by their due dates, and the automation's runs.
    const week = between('2027-03-01', '2027-03-08');
    const from = (calendarId: string) => week.filter((e) => e.calendarId === calendarId);
    expect(from('tasks')).toMatchObject([{ title: 'Order soil', allDay: true, showAs: 'free', color: '#22c55e', canEdit: false, link: { kind: 'task', id: task.id } }]);
    expect(from('projects')).toMatchObject([{ title: 'Garden is due', allDay: true, color: '#22c55e' }]);
    expect(from('automations').map((e) => [new Date(e.start).getDay(), new Date(e.start).getHours(), new Date(e.start).getMinutes()])).toEqual([1, 2, 3, 4, 5].map((d) => [d, 7, 30]));
    expect(from('automations')[0]).toMatchObject({ color: CALENDAR_LINK_COLORS.automation, showAs: 'free' });

    // Each of them can be hidden, and a finished task leaves.
    await kernel.call('calendar.update', { id: 'fbrx', calendars: [{ id: 'automations', enabled: false }, { id: 'projects', enabled: false }] }, USER);
    kernel.workspace.saveTask({ ...task, status: 'done' });
    expect(between('2027-03-01', '2027-03-08').filter((e) => e.calendarId !== 'events')).toEqual([]);
  });

  it('changes and deletes a whole repeating event, from any of its days', async () => {
    const e = await create({ title: 'Gym', start: at('2027-03-01', '18:00').toISOString(), durationMinutes: 60, repeat: 'daily', repeatUntil: '2027-03-07' });
    const third = mine(between('2027-03-03', '2027-03-04'))[0];
    expect(third.id).not.toBe(e.id);
    const moved = (await kernel.call('calendar.edit', { id: third.id, title: 'Run', start: at('2027-03-01', '07:00').toISOString(), durationMinutes: 45, repeatUntil: '2027-03-03' }, USER)) as CalendarEvent;
    expect(moved).toMatchObject({ title: 'Run', series: e.series, repeat: 'daily', repeatUntil: '2027-03-03' });
    expect(mine(between('2027-03-01', '2027-03-10')).map((x) => [x.title, new Date(x.start).getHours(), (new Date(x.end).getTime() - new Date(x.start).getTime()) / 60_000])).toEqual([
      ['Run', 7, 45],
      ['Run', 7, 45],
      ['Run', 7, 45],
    ]);
    await expect(kernel.call('calendar.edit', { id: e.id, durationMinutes: 30 }, USER)).rejects.toThrow(/give its start too/);
    await expect(kernel.call('calendar.edit', { id: e.id, title: 'x' }, { origin: 'agent', actor: 'agent' })).rejects.toThrow(/person at this workstation/);
    await kernel.call('calendar.delete', { accountId: 'fbrx', id: third.id }, USER);
    expect(mine(between('2027-03-01', '2027-03-10'))).toEqual([]);
    // With the calendar hidden, what is added is still saved and shown to whoever added it.
    await kernel.call('calendar.update', { id: 'fbrx', enabled: false }, USER);
    expect(await create({ title: 'Quiet', start: '2027-03-09' })).toMatchObject({ title: 'Quiet', allDay: true });
    expect(between('2027-03-09', '2027-03-10')).toEqual([]);
  });

  it('reminds before your events, not before tasks or automations, and lets Fabrix add to it', async () => {
    const soon = new Date(Date.now() + 5 * 60_000);
    await create({ title: 'Call the plumber', start: soon.toISOString(), durationMinutes: 30 });
    kernel.automations.create({ name: 'Every so often', prompt: 'x', schedule: { kind: 'interval', minutes: 15 }, notify: 'always', online: false, hotkey: '', enabled: true }, 'test');
    const notes: NotificationEvent[] = [];
    kernel.events.on('notification', (n) => notes.push(n));
    kernel.calendar.remind();
    expect(notes.map((n) => n.title)).toEqual(['Call the plumber']);

    const project = kernel.workspace.saveProject({ name: 'Kitchen', color: '#0ea5e9' });
    const tool = kernel.registry.get('calendar.create_event')!;
    const r = await tool.run({ title: 'Pick tiles', start: '2027-03-04T16:00', durationMinutes: 60, project: 'kitchen' }, {} as any);
    expect(r.output).toBe(`Added "Pick tiles" to FBRX (Events): Thu, Mar 4 ${at('2027-03-04', '16:00').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}–${at('2027-03-04', '17:00').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}, for Kitchen.`);
    expect((r.data as { event: CalendarEvent }).event).toMatchObject({ madeBy: 'fabrix', color: '#0ea5e9', link: { kind: 'project', id: project.id } });
    const unlinked = await tool.run({ title: 'Stretch', start: '2027-03-04T08:00' }, {} as any);
    expect((unlinked.data as { event: CalendarEvent }).event.color).toBe(CALENDAR_LINK_COLORS.fabrix);
    const agenda = await kernel.registry.get('calendar.agenda')!.run({ from: '2027-03-04' }, {} as any);
    expect(agenda.output).toMatch(/Pick tiles · project Kitchen \[FBRX\]/);
  });
});
