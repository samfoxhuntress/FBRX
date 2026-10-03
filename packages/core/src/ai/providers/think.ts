import type { ProviderChunk } from './types';

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Reasoning models served without a reasoning parser (some Ollama and llama.cpp setups) write their thinking into the
 * answer between <think> and </think>. This moves it out of the answer so it can be shown as thinking instead. Only a
 * block at the very start of the answer counts, so an answer that merely mentions the tag is left alone.
 */
export class ThinkSplitter {
  private buf = '';
  private inThink = false;
  private decided = false;

  push(delta: string): ProviderChunk[] {
    this.buf += delta;
    const out: ProviderChunk[] = [];
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf(CLOSE);
        if (end >= 0) {
          if (end > 0) out.push({ type: 'thinking', delta: this.buf.slice(0, end) });
          this.buf = this.buf.slice(end + CLOSE.length).replace(/^\s+/, '');
          this.inThink = false;
          continue;
        }
        // Keep a possible partial "</think>" for the next delta.
        const keep = Math.min(this.buf.length, CLOSE.length - 1);
        if (this.buf.length > keep) out.push({ type: 'thinking', delta: this.buf.slice(0, this.buf.length - keep) });
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      if (!this.decided) {
        const lead = this.buf.trimStart();
        if (lead.startsWith(OPEN)) {
          this.decided = true;
          this.inThink = true;
          this.buf = lead.slice(OPEN.length);
          continue;
        }
        if (OPEN.startsWith(lead)) return out; // could still become "<think>"
        this.decided = true;
      }
      if (this.buf) out.push({ type: 'text', delta: this.buf });
      this.buf = '';
      return out;
    }
  }

  /** Whatever is left when the stream ends. */
  flush(): ProviderChunk[] {
    const rest = this.buf;
    this.buf = '';
    if (!rest) return [];
    return [{ type: this.inThink ? 'thinking' : 'text', delta: rest }];
  }
}
