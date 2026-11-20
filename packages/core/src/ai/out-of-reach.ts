import type { ToolSpec } from '../tools/types';

/**
 * What FBRX has no tool for at all, said once in the instructions. A model only sees the tools it is offered, so it
 * cannot tell "not on the short list" from "FBRX cannot", and asks for an email address as if it could send (Noah,
 * round two: 6 of 8 runs). Built from the tools there are: a plugin or connection that sends email (say) takes email
 * off the list.
 */
const OUT_OF_REACH: Array<{ what: string; has: RegExp }> = [
  { what: 'send email', has: /\b(e-?mails?|mail|gmail|outlook|smtp)\b/i },
  { what: 'send texts or chat messages', has: /\bsms\b|text_message|text message|send_text|messag|whatsapp|telegram|slack|discord|imessage/i },
  { what: 'make phone calls', has: /phone|dial|voip/i },
  { what: 'book or reserve anything with a business (travel, tables, appointments)', has: /\b(book|booking|reserv\w*|flights?|hotels?)\b/i },
  { what: 'buy or pay for anything', has: /\b(pay|pays|payments?|purchases?|buy|checkout|orders?)\b/i },
];

/** The instruction line, or null when the tools there cover all of it. */
export function outOfReachLine(tools: Pick<ToolSpec, 'name' | 'title'>[]): string | null {
  const names = tools.map((t) => `${t.name.replace(/[._]/g, ' ')} ${t.title}`);
  const missing = OUT_OF_REACH.filter((o) => !names.some((n) => o.has.test(n))).map((o) => o.what);
  if (!missing.length) return null;
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} or ${missing[missing.length - 1]}` : missing[0];
  return `- FBRX has no tool at all to ${list}. Asked to, say plainly that you can't from here and offer what you can: a draft to copy and send, a note, a reminder.`;
}
