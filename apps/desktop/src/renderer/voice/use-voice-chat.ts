import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings, VoiceModelStatus } from '@fbrx/shared';
import { call } from '../client';
import { isNoise, isSpeaking, onSpeaking, record, stopSpeaking, transcribe, warmUp, type Recording } from './voice';

export type VoiceChatState = 'idle' | 'listening' | 'transcribing';

/**
 * The microphone button and hands-free conversation for a chat box: listen, write down what was said with Whisper,
 * hand the text over, and (hands-free) listen again once the spoken reply has finished.
 */
export function useVoiceChat(o: { settings: Settings | undefined; onText: (text: string, send: boolean) => void }) {
  const [state, setState] = useState<VoiceChatState>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsModel, setNeedsModel] = useState<VoiceModelStatus | null>(null);
  const [handsFree, setHandsFree] = useState(false);
  const rec = useRef<Recording | null>(null);
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;
  const settingsRef = useRef(o.settings);
  settingsRef.current = o.settings;
  const onTextRef = useRef(o.onText);
  onTextRef.current = o.onText;

  const finish = useCallback(async () => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    const s = settingsRef.current;
    setState('transcribing');
    setLevel(0);
    try {
      const audio = await r.stop();
      const text = audio.length && s ? await transcribe(audio, s.voice.sttModel) : '';
      if (isNoise(text)) {
        if (handsFreeRef.current) {
          setHandsFree(false);
          setError('Hands-free paused: I did not hear anything. Press the headset to start again.');
        }
        return;
      }
      onTextRef.current(text, handsFreeRef.current || (s?.voice.autoSend ?? true));
    } catch (e) {
      setError((e as Error).message);
      setHandsFree(false);
    } finally {
      setState('idle');
    }
  }, []);

  const start = useCallback(async () => {
    const s = settingsRef.current;
    if (!s || rec.current) return;
    setError(null);
    stopSpeaking();
    const models = await call('voice.models').catch(() => []);
    const m = models.find((x) => x.id === s.voice.sttModel);
    if (!m?.installed) {
      setNeedsModel(m ?? null);
      setHandsFree(false);
      return;
    }
    warmUp(s.voice.sttModel);
    try {
      rec.current = await record({
        deviceId: s.voice.micId || undefined,
        onLevel: setLevel,
        // Hands-free stops after a short pause; a click-to-talk turn waits a little longer before stopping itself.
        silenceMs: handsFreeRef.current ? 1300 : 2200,
        noSpeechMs: handsFreeRef.current ? 9000 : 15000,
        onAutoStop: () => void finish(),
      });
      setState('listening');
    } catch (e) {
      setError((e as Error).message);
      setHandsFree(false);
    }
  }, [finish]);

  const toggle = useCallback(() => {
    if (state === 'listening') void finish();
    else if (state === 'idle') void start();
  }, [state, start, finish]);

  const cancel = useCallback(() => {
    rec.current?.cancel();
    rec.current = null;
    setState('idle');
    setLevel(0);
  }, []);

  const toggleHandsFree = useCallback(() => {
    if (handsFreeRef.current) {
      setHandsFree(false);
      cancel();
      stopSpeaking();
    } else {
      setHandsFree(true);
      handsFreeRef.current = true;
      void start();
    }
  }, [cancel, start]);

  /** Hands-free: once the agent has answered and finished speaking, listen again. */
  const replyFinished = useCallback(() => {
    if (!handsFreeRef.current) return;
    const go = () => setTimeout(() => handsFreeRef.current && !rec.current && void start(), 350);
    if (!isSpeaking()) return go();
    const off = onSpeaking((on) => {
      if (!on) {
        off();
        go();
      }
    });
  }, [start]);

  useEffect(() => () => rec.current?.cancel(), []);

  return { state, level, error, setError, needsModel, setNeedsModel, handsFree, toggle, start, cancel, toggleHandsFree, replyFinished };
}
