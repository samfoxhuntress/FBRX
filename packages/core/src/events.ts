import { EventEmitter } from 'node:events';
import type { CoreEventName, CoreEvents } from '@fbrx/shared';

export type CoreEventListener = <E extends CoreEventName>(event: E, payload: CoreEvents[E]) => void;

/** Typed in-process event bus. Every transport (IPC, Local API SSE, fleet) subscribes here. */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly anyListeners = new Set<CoreEventListener>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<E extends CoreEventName>(event: E, payload: CoreEvents[E]): void {
    this.emitter.emit(event, payload);
    for (const l of this.anyListeners) {
      try {
        l(event, payload);
      } catch {
        /* listeners must not break emitters */
      }
    }
  }

  on<E extends CoreEventName>(event: E, listener: (payload: CoreEvents[E]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  once<E extends CoreEventName>(event: E, listener: (payload: CoreEvents[E]) => void): () => void {
    this.emitter.once(event, listener);
    return () => this.emitter.off(event, listener);
  }

  onAny(listener: CoreEventListener): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
    this.anyListeners.clear();
  }
}
