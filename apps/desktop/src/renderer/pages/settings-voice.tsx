import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeepPartial, Settings, VoiceModelId, VoiceModelStatus } from '@fbrx/shared';
import { NATURAL_PREFIX, NATURAL_VOICES, NATURAL_VOICE_PACK } from '@fbrx/shared';
import { VOICE_WPM, addressAs } from '@fbrx/shared';
import { Button, Callout, Card, Field, Icons, Select, Status, Toggle, useAction, useToast } from '@fbrx/ui';
import { bridge, call, onEvent } from '../client';
import { isLocked, useCore } from '../hooks';
import { isNoise, record, say, speechSupported, stopSpeaking, transcribe, useVoices, warmNaturalVoice, type Recording } from '../voice/voice';

/** Settings → Voice: talking to the agent (speech recognition on this computer) and how it talks back. */

export function wpmLabel(wpm: number): string {
  return wpm < 160 ? 'Relaxed' : wpm < 195 ? 'Conversational' : wpm < 240 ? 'Brisk' : wpm < 290 ? 'Fast' : 'Very fast';
}

/** Download progress for voice models, shared by Settings and the agent page. */
export function useVoiceModels() {
  const models = useCore('voice.models', undefined, ['voice.download']);
  const [progress, setProgress] = useState<Record<string, { received: number; total: number; error: string | null; done: boolean }>>({});
  useEffect(
    () =>
      onEvent('voice.download', (e) => {
        setProgress((p) => ({ ...p, [e.model]: { received: e.received, total: e.total, error: e.error, done: e.done } }));
      }),
    [],
  );
  return { models, progress };
}

export function ModelDownload({ model, onDone }: { model: VoiceModelStatus; onDone?: () => void }) {
  const { progress } = useVoiceModels();
  const { run } = useAction();
  const p = progress[model.id];
  useEffect(() => {
    if (p?.done && !p.error) onDone?.();
  }, [p?.done, p?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  if (model.installed) return <Status tone="good">On this computer</Status>;
  if (model.downloading || (p && !p.done)) {
    const pct = p ? Math.min(99, Math.round((p.received / Math.max(1, p.total)) * 100)) : 0;
    return (
      <div className="voice-dl">
        <div className="voice-dl-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="fx-muted">{pct}%</span>
        <Button size="sm" variant="ghost" onClick={() => void call('voice.cancel')}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <>
      {p?.error && <span className="voice-dl-error">{p.error}</span>}
      <Button size="sm" icon="download" onClick={() => void run('dl', () => call('voice.install', { model: model.id }))}>
        Download ({model.sizeMB} MB)
      </Button>
    </>
  );
}

function MicTest({ model, micId }: { model: VoiceModelId; micId: string }) {
  const [state, setState] = useState<'idle' | 'listening' | 'working'>('idle');
  const [level, setLevel] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const finish = async () => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    setState('working');
    try {
      const audio = await r.stop();
      const t = audio.length ? await transcribe(audio, model) : '';
      setText(isNoise(t) ? '(nothing heard)' : t);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setState('idle');
      setLevel(0);
    }
  };
  const start = async () => {
    setError(null);
    setText(null);
    try {
      rec.current = await record({ deviceId: micId || undefined, onLevel: setLevel, silenceMs: 1400, noSpeechMs: 8000, onAutoStop: () => void finish() });
      setState('listening');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => () => rec.current?.cancel(), []);
  return (
    <div className="mic-test">
      <Button icon="mic" variant={state === 'listening' ? 'primary' : undefined} loading={state === 'working'} onClick={() => void (state === 'listening' ? finish() : start())}>
        {state === 'listening' ? 'Listening… (click to stop)' : state === 'working' ? 'Writing it down…' : 'Test the microphone'}
      </Button>
      <div className="mic-level" aria-hidden>
        <div style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      {text !== null && <div className="mic-heard">“{text}”</div>}
      {error && <Callout tone="warning">{error}</Callout>}
    </div>
  );
}

export function VoiceSettings() {
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const settings = s.data?.settings;
  const { models } = useVoiceModels();
  const voices = useVoices();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [wpm, setWpm] = useState<number | null>(null);
  const [pitch, setPitch] = useState<number | null>(null);
  const { run } = useAction();
  const toast = useToast();
  const patch = (p: DeepPartial<Settings>) => run('patch', () => call('settings.update', { patch: p }));
  const L = (p: string) => isLocked(s.data?.locked, p);

  const loadMics = async () => {
    const all = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []);
    setMics((all ?? []).filter((d) => d.kind === 'audioinput'));
  };
  useEffect(() => {
    void loadMics();
    navigator.mediaDevices?.addEventListener?.('devicechange', loadMics);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', loadMics);
  }, []);

  const voiceOptions = useMemo(() => {
    const lang = navigator.language.slice(0, 2);
    const sorted = [...voices].sort((a, b) => Number(b.lang.startsWith(lang)) - Number(a.lang.startsWith(lang)) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    return [{ value: '', label: 'System default' }, ...sorted.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})${v.localService ? '' : ' · online'}` }))];
  }, [voices]);

  if (!settings) return null;
  const v = settings.voice;
  const shownWpm = wpm ?? v.wpm;
  const shownPitch = pitch ?? v.pitch;
  const name = addressAs(settings) || 'there';
  const sample = `Hi ${name}, I'm ${settings.ai.agentName}. This is how I sound at ${shownWpm} words per minute. Ask me anything, out loud.`;
  const chosen = (models.data ?? []).find((m) => m.id === v.sttModel);
  const listenModels = (models.data ?? []).filter((m) => m.kind === 'listen');
  const pack = (models.data ?? []).find((m) => m.id === NATURAL_VOICE_PACK.id);
  const naturalId = v.voiceName.startsWith(NATURAL_PREFIX) ? v.voiceName.slice(NATURAL_PREFIX.length) : null;
  const hear = (voiceName: string, rate = shownWpm) => {
    stopSpeaking();
    say(sample, { voiceName, wpm: rate, pitch: shownPitch });
  };
  const pickNatural = (id: string, rate?: number) => {
    warmNaturalVoice();
    void patch({ voice: { voiceName: `${NATURAL_PREFIX}${id}`, ...(rate ? { wpm: rate } : {}) } }).then(() => hear(`${NATURAL_PREFIX}${id}`, rate));
  };

  return (
    <>
      <Card title={`Talk to ${settings.ai.agentName}`} subtitle="Press the microphone next to Send and speak. What you say is turned into text on this computer by Whisper; nothing is sent anywhere to be transcribed.">
        <div className="voice-models">
          {listenModels.map((m) => (
            <div key={m.id} className={`voice-model${v.sttModel === m.id ? ' active' : ''}`}>
              <label className="voice-model-pick">
                <input type="radio" name="stt" checked={v.sttModel === m.id} disabled={L('voice.sttModel')} onChange={() => void patch({ voice: { sttModel: m.id as VoiceModelId } })} />
                <span>
                  <b>{m.name}</b> <span className="fx-muted">· {m.sizeMB} MB{m.english ? ' · English' : ''}</span>
                  <span className="voice-model-note">{m.note}</span>
                </span>
              </label>
              <div className="voice-model-act">
                <ModelDownload model={m} onDone={() => void models.reload()} />
                {m.installed && (
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${m.name}`} onClick={() => void run('rm', () => call('voice.remove', { model: m.id }).then(() => models.reload()), 'Removed')} />
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="voice-form">
          <Field label="Microphone">
            <Select
              value={v.micId}
              disabled={L('voice.micId')}
              onChange={(e) => void patch({ voice: { micId: e.target.value } })}
              options={[{ value: '', label: 'System default' }, ...mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))]}
            />
          </Field>
          {chosen?.installed ? <MicTest model={v.sttModel} micId={v.micId} /> : <p className="fx-muted voice-hint">Download the chosen model above to try the microphone.</p>}
          <Toggle checked={v.autoSend} disabled={L('voice.autoSend')} onChange={(x) => void patch({ voice: { autoSend: x } })} label="Send what I said right away (otherwise it waits in the box so you can check it)" />
          <Toggle checked={v.handsFree} disabled={L('voice.handsFree')} onChange={(x) => void patch({ voice: { handsFree: x, ...(x ? { readReplies: true, autoSend: true } : {}) } })} label="Hands-free conversation: after each spoken reply, listen again (stops after a quiet moment)" />
          <Toggle checked={v.acknowledge} disabled={L('voice.acknowledge')} onChange={(x) => void patch({ voice: { acknowledge: x } })} label={`When you speak, ${settings.ai.agentName} says it heard you before it starts working`} />
          <Toggle checked={v.thinkingSound} disabled={L('voice.thinkingSound')} onChange={(x) => void patch({ voice: { thinkingSound: x } })} label="Play a soft thinking sound while it works on what you said" />
          <p className="fx-muted voice-hint">
            Prefer your system's dictation? It works in every FBRX text box: press <kbd>Win</kbd>+<kbd>H</kbd> on Windows, or the microphone key (or <kbd>Fn</kbd> twice) on a Mac.
          </p>
        </div>
      </Card>

      <Card
        title={`${settings.ai.agentName}'s voice`}
        subtitle="Natural voices are made on this computer and sound the most lifelike. Your computer's own voices work too, and you can add more of them."
      >
        <div className="voice-section-head">
          <b>Natural voices</b>
          {pack && !pack.installed && <span className="fx-muted">One download ({pack.sizeMB} MB), then they work offline.</span>}
          {pack && (
            <span className="voice-section-act">
              <ModelDownload model={pack} onDone={() => (void models.reload(), pickNatural('bm_george', 185))} />
              {pack.installed && (
                <Button size="sm" variant="ghost" icon="trash" aria-label="Remove the natural voices" onClick={() => void run('rm', () => call('voice.remove', { model: pack.id }).then(() => models.reload()), 'Removed')} />
              )}
            </span>
          )}
        </div>
        {pack?.installed ? (
          <>
            <div className="voice-presets">
              <button className={`voice-preset${naturalId === 'bm_george' ? ' on' : ''}`} disabled={L('voice.voiceName')} onClick={() => pickNatural('bm_george', 185)}>
                <Icons.bowtie size={14} /> The butler <span>George · British · unhurried</span>
              </button>
              <button className={`voice-preset${naturalId === 'af_heart' ? ' on' : ''}`} disabled={L('voice.voiceName')} onClick={() => pickNatural('af_heart', 210)}>
                <Icons.sparkles size={14} /> The assistant <span>Heart · American · warm</span>
              </button>
              <button className={`voice-preset${naturalId === 'bm_fable' ? ' on' : ''}`} disabled={L('voice.voiceName')} onClick={() => pickNatural('bm_fable', 175)}>
                <Icons.book size={14} /> The storyteller <span>Fable · British · warm</span>
              </button>
            </div>
            <div className="natural-voices">
              {NATURAL_VOICES.map((nv) => (
                <div key={nv.id} className={`natural-voice${naturalId === nv.id ? ' on' : ''}`}>
                  <button className="natural-voice-pick" disabled={L('voice.voiceName')} onClick={() => pickNatural(nv.id)} aria-pressed={naturalId === nv.id}>
                    <b>{nv.name}</b>
                    <span className="fx-muted">
                      {nv.accent} {nv.who}
                    </span>
                    <span className="natural-voice-note">{nv.note}</span>
                  </button>
                  <button className="natural-voice-play" title={`Hear ${nv.name}`} aria-label={`Hear ${nv.name}`} onClick={() => (warmNaturalVoice(), hear(`${NATURAL_PREFIX}${nv.id}`))}>
                    <Icons.play size={13} />
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="fx-muted voice-hint">Includes George, an older British gentleman (the butler), Fable, Lewis and Daniel, Emma and Isabella, and American voices such as Heart and Michael.</p>
        )}

        <div className="voice-section-head">
          <b>Voices on this computer</b>
          <span className="voice-section-act">
            <Button size="sm" variant="ghost" icon="external" onClick={() => void (window.fbrx as unknown as { openVoiceSettings?: () => Promise<boolean> } | undefined)?.openVoiceSettings?.()}>
              Get more voices
            </Button>
          </span>
        </div>
        {!speechSupported() || !voices.length ? (
          <Callout tone="info">{bridge.platform === 'linux' ? 'No system voices were found. Install speech-dispatcher with a voice (for example espeak-ng) to hear replies.' : 'Loading the voices on this computer…'}</Callout>
        ) : null}
        <div className="voice-form">
          <Field
            label="Voice"
            help={
              bridge.platform === 'darwin'
                ? 'More voices: System Settings → Accessibility → Spoken Content → System voice → Manage Voices. Premium voices (for example Jamie, a British man) sound best. Restart FBRX to see new ones.'
                : bridge.platform === 'win32'
                  ? 'More voices: Settings → Time & language → Speech → Add voices, for example English (United Kingdom) for George and Hazel. Restart FBRX to see new ones.'
                  : undefined
            }
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={naturalId ? '' : v.voiceName} disabled={L('voice.voiceName')} onChange={(e) => void patch({ voice: { voiceName: e.target.value } })} options={naturalId ? [{ value: '', label: 'Using a natural voice (pick one here to switch)' }, ...voiceOptions.slice(1)] : voiceOptions} />
              <Button icon="speaker" onClick={() => hear(v.voiceName)}>
                Hear it
              </Button>
            </div>
          </Field>
          <Field
            label={
              <>
                Speed <span className="budget-value">{shownWpm}</span> words per minute · {wpmLabel(shownWpm)}
              </>
            }
            help="Everyday conversation runs about 150–180 words a minute; 200–230 sounds crisp without rushing. Audiobooks on fast forward start around 280."
          >
            <input
              type="range"
              min={VOICE_WPM.min}
              max={VOICE_WPM.max}
              step={5}
              value={shownWpm}
              disabled={L('voice.wpm')}
              aria-label="Speaking speed in words per minute"
              onChange={(e) => setWpm(Number(e.target.value))}
              onPointerUp={() => wpm !== null && void patch({ voice: { wpm } }).then(() => setWpm(null))}
              onKeyUp={() => wpm !== null && void patch({ voice: { wpm } }).then(() => setWpm(null))}
            />
            <div className="wpm-scale">
              <span>{VOICE_WPM.min}</span>
              <span>180</span>
              <span>240</span>
              <span>300</span>
              <span>{VOICE_WPM.max}</span>
            </div>
          </Field>
          <Field label={`Pitch · ${shownPitch.toFixed(2)}`} help={naturalId ? 'Natural voices keep their own pitch.' : undefined}>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={shownPitch}
              disabled={L('voice.pitch') || !!naturalId}
              aria-label="Pitch"
              onChange={(e) => setPitch(Number(e.target.value))}
              onPointerUp={() => pitch !== null && void patch({ voice: { pitch } }).then(() => setPitch(null))}
              onKeyUp={() => pitch !== null && void patch({ voice: { pitch } }).then(() => setPitch(null))}
            />
          </Field>
          <Toggle
            checked={v.readReplies}
            disabled={L('voice.readReplies')}
            onChange={(x) => void patch({ voice: { readReplies: x } }).then(() => x && toast.info('Replies will be read aloud', 'The speaker button next to Send turns it off for a while.'))}
            label={`Read ${settings.ai.agentName}'s replies aloud`}
          />
        </div>
      </Card>
    </>
  );
}

