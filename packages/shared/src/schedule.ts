/**
 * Things that run by themselves at a time of day: every day, or one day a week (FBRX Shield's scheduled scan, FBRX
 * Time's backups). A computer that was off when one fell due runs it when it is next on.
 */

export type Schedule = 'off' | 'daily' | 'weekly';
export const SCHEDULES: readonly Schedule[] = ['off', 'daily', 'weekly'];
/** 24-hour local time, "21:30". */
export const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** When it last fell due at or before `now` (local time), or null when the schedule is off. */
export function lastDue(schedule: Schedule, time: string, day: number, now: Date): Date | null {
  if (schedule === 'off') return null;
  const [h, m] = (SCHEDULE_TIME_PATTERN.test(time) ? time : '12:00').split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (schedule === 'daily') {
    if (at > now) at.setDate(at.getDate() - 1);
    return at;
  }
  at.setDate(at.getDate() - ((at.getDay() - day + 7) % 7));
  if (at > now) at.setDate(at.getDate() - 7);
  return at;
}

/** The next time it falls due after `now`, or null when the schedule is off. */
export function nextDue(schedule: Schedule, time: string, day: number, now: Date): Date | null {
  const last = lastDue(schedule, time, day, now);
  if (!last) return null;
  const next = new Date(last);
  next.setDate(next.getDate() + (schedule === 'daily' ? 1 : 7));
  return next;
}

/** Whether it should run now: it fell due since it last ran. With no run yet, the first one waits for its time. */
export function isDue(schedule: Schedule, time: string, day: number, lastRun: string | null, now: Date): boolean {
  const due = lastDue(schedule, time, day, now);
  if (!due || !lastRun) return false;
  return Date.parse(lastRun) < due.getTime();
}

/** "every day at 9:30 PM", "Wednesdays at 9:30 PM", "off". */
export function describeSchedule(schedule: Schedule, time: string, day: number): string {
  if (schedule === 'off') return 'off';
  const [h, m] = time.split(':').map(Number);
  const clock = new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return schedule === 'daily' ? `every day at ${clock}` : `${WEEKDAYS[day]}s at ${clock}`;
}
