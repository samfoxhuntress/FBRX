import type { CalendarEvent } from '@fbrx/shared';

/** "9:30 AM" in the person's own clock. */
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "9:30 – 10:00 AM", "11:30 AM – 1:00 PM" or "All day". */
export const eventWhen = (e: CalendarEvent) => {
  if (e.allDay) return 'All day';
  const a = fmtTime(e.start);
  const b = fmtTime(e.end);
  const am = /\s?([AP]M)$/i;
  const pa = am.exec(a)?.[1];
  return pa && pa === am.exec(b)?.[1] ? `${a.replace(am, '')} – ${b}` : `${a} – ${b}`;
};
