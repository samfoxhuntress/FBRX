import { useEffect, useState } from 'react';
import { formatTokens, type AgentEvent, type ContextReading } from '@fbrx/shared';
import { call, onEvent } from './client';
import { navigate } from './app';

/**
 * How full a chat is for the agent that answers it: estimated when the chat opens or the model changes (ai.context),
 * then as the provider counted each request (the run's events).
 */
export function useContextReading(conversationId: string | null, providerId: string, model: string): ContextReading | null {
  const [reading, setReading] = useState<ContextReading | null>(null);
  useEffect(() => {
    let live = true;
    call('ai.context', { ...(conversationId ? { conversationId } : {}), ...(providerId ? { providerId } : {}), ...(model ? { model } : {}) }).then(
      (r) => live && setReading(r),
      () => live && setReading(null),
    );
    const off = onEvent('agent', (e: AgentEvent) => {
      if ((e.type === 'run.progress' || e.type === 'run.completed') && e.context && e.conversationId === conversationId) setReading(e.context);
    });
    return () => {
      live = false;
      off();
    };
  }, [conversationId, providerId, model]);
  return reading;
}

const tone = (share: number) => (share >= 0.95 ? 'full' : share >= 0.75 ? 'near' : 'ok');

/**
 * The gauge under the chat: the context window against what the conversation takes, and with a monthly cloud AI budget
 * the month against it. Opens AI usage.
 */
export function ContextGauge({ reading }: { reading: ContextReading | null }) {
  if (!reading?.windowTokens) return null;
  const share = Math.min(1, reading.usedTokens / reading.windowTokens);
  const m = reading.month;
  const title = [
    `Context window: ${reading.windowTokens.toLocaleString('en-US')} tokens; ${reading.estimated ? 'about ' : ''}${reading.usedTokens.toLocaleString('en-US')} in use (${Math.round(share * 100)}%).`,
    reading.folded ? `${reading.folded} older request${reading.folded === 1 ? ' is' : 's are'} folded into a short digest to fit.` : '',
    m ? `Cloud AI this month: ${m.used.toLocaleString('en-US')} of ${m.budget.toLocaleString('en-US')} tokens.` : '',
    'Click for AI usage.',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={`ctx-gauge ${tone(share)}`} title={title} onClick={() => navigate('ai-usage')}>
      <span className="ctx-track" aria-hidden>
        <span style={{ width: `${share * 100}%` }} />
      </span>
      <span>
        Context {reading.estimated ? '~' : ''}
        {formatTokens(reading.usedTokens)} / {formatTokens(reading.windowTokens)} tokens
      </span>
      {reading.folded > 0 && <span className="ctx-note">{reading.folded} folded</span>}
      {m && (
        <span className={`ctx-month ${tone(m.used / m.budget)}`}>
          Month {formatTokens(m.used)} / {formatTokens(m.budget)}
        </span>
      )}
    </button>
  );
}
