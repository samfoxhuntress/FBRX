/**
 * What a request asks for, apart from what it carries. Tools and toolkit actions are picked from the words of a request
 * (tool-shortlist.ts, toolkit.ts), and some words are not the request: a name in quotes, what the person wants saved
 * ("save this as a snippet: du -sh *"), and the subject of their own notes or tasks ("my notes about the router").
 * Those would bring in tools nobody asked for (Disk space, Check the internet) and push out the ones the job needs.
 */

/** Words that end the subject after "notes about …": "my notes about the router are a mess". */
const SUBJECT_ENDS = new Set('and then but are is was were has have had so to from in into with can could would please that which who when where'.split(' '));
/** The person's own things whose subject is not a request: notes, tasks, lists, files, snippets, projects. */
const OWN_THINGS = /^(notes?|tasks?|to-?dos?|lists?|files?|documents?|docs?|snippets?|projects?|entry|entries)$/i;
const ABOUT = /^(about|on|regarding|re|for|called|named|titled)$/i;

/** The request without code, quoted names, the content it asks to save, and the subject of the person's notes or tasks. */
export function requestWords(text: string): string {
  let t = text
    // Code (`du -sh *`), and a name in quotes ("a snippet called 'disk usage'"). Other quotes stay: an error message
    // in quotes ("it says 'DNS server not responding'") is what the request is about.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b(called|named|titled|labell?ed|as)\s+("[^"\n]{0,200}"|“[^”\n]{0,200}”|‘[^’\n]{0,200}’|'[^'\n]{1,200}'(?=$|[\s.,:;!?)]))/gi, '$1 ');
  // What comes after the colon in "save this … : <content>" (or write, add, note down, put, paste, store, keep, jot).
  // Not "Note: the Wi-Fi drops", where the colon comes straight after the word.
  t = t.replace(/(\b(?:save|write|add|note|put|append|paste|store|keep|jot)\b\s+[^:\s][^:\n]{0,120}):[\s\S]*$/i, '$1');
  // "with: milk, eggs" and "that says …" carry content too.
  t = t.replace(/\b(with|saying|that says|reading)\s*:[\s\S]*$/i, ' ');
  // The subject of the person's own things: "notes about the router", "a task called fix the printer".
  const tokens = t.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    out.push(tokens[i]);
    const word = tokens[i].replace(/[^\p{L}\p{N}-]/gu, '');
    const next = tokens[i + 2]?.replace(/[^\p{L}\p{N}-]/gu, '') ?? '';
    if (!OWN_THINGS.test(word) || !ABOUT.test(next) || /[.,;:!?]$/.test(tokens[i])) continue;
    out.push(tokens[i + 1], tokens[i + 2]);
    i += 2;
    // Up to four words, to the end of the phrase.
    for (let n = 0; n < 4 && i + 2 < tokens.length; n++) {
      const w = tokens[i + 2];
      if (SUBJECT_ENDS.has(w.toLowerCase().replace(/[^a-z]/g, ''))) break;
      i += 2;
      out.push(' ');
      if (/[.,;:!?]$/.test(w)) {
        out.push(w.slice(-1));
        break;
      }
    }
  }
  return out.join('');
}

/**
 * Whether a request is about the person's own notes, tasks, lists or files (not the task manager or the taskbar):
 * troubleshooting tools and actions go after the ones for that.
 */
export function aboutOwnWork(text: string): boolean {
  return /\b(notes?|to-?dos?|snippets?)\b|\btasks?\b(?!\s*(manager|bar|scheduler|list\s*\/))|\b(my|our)\s+(\w+\s+)?(lists?|files?|documents?|projects?|notes?|tasks?)\b/i.test(text);
}
