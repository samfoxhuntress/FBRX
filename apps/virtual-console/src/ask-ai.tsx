import { Button } from '@fbrx/ui';
import { useApp, useRoute } from './state';

/**
 * Ask the AI about this: the server's own AI (the ai role), from anywhere in the console. The button opens a new chat
 * with what it is about already in the box (the item's details and a first question), for the person to change or
 * send as it is. Nothing is sent until they do.
 */
const DRAFT = 'fbrx.virtual.ai-draft';

export function takeAiDraft(): string | null {
  try {
    const t = sessionStorage.getItem(DRAFT);
    sessionStorage.removeItem(DRAFT);
    return t;
  } catch {
    return null;
  }
}

/** Shown to operators and administrators on a server with the ai role. */
export function AskAiButton({ what, details, question, label = 'Ask the AI' }: { what: string; details: string | (() => string); question: string; label?: string }) {
  const app = useApp();
  const [, go] = useRoute();
  if (!app.has('ai') || !app.can('operator')) return null;
  return (
    <Button
      size="sm"
      icon="sparkles"
      title={`Open a chat with this server's AI about ${what}`}
      onClick={() => {
        const d = (typeof details === 'function' ? details() : details).trim();
        try {
          sessionStorage.setItem(DRAFT, `${question}\n\nAbout ${what}:\n${d.slice(0, 12_000)}`);
        } catch {
          /* private mode: the chat opens empty */
        }
        go('fabrix');
      }}
    >
      {label}
    </Button>
  );
}

/** An object as short "key: value" lines, for the AI to read (nested values as JSON). */
export function describeFor(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
}
