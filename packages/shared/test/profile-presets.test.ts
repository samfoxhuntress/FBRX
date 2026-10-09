import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PROFILE_PRESETS, PROFILE_SETTINGS, SettingsSchema, applyPreset, deepMerge, getPath, presetApplied, setPath } from '../src/index';

describe('profile presets and the settings catalog', () => {
  it('names only real settings, with values the settings accept', () => {
    for (const s of PROFILE_SETTINGS) expect(getPath(DEFAULT_SETTINGS, s.path), s.path).not.toBeUndefined();
    for (const p of PROFILE_PRESETS) {
      for (const k of [...Object.keys(p.values), ...p.lock]) expect(getPath(DEFAULT_SETTINGS, k), `${p.id}: ${k}`).not.toBeUndefined();
      let patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.values)) patch = setPath(patch, k, v);
      expect(() => SettingsSchema.parse(deepMerge(DEFAULT_SETTINGS, patch)), p.id).not.toThrow();
    }
    for (const s of PROFILE_SETTINGS.filter((x) => x.kind === 'select')) {
      for (const o of s.options ?? []) expect(() => SettingsSchema.parse(deepMerge(DEFAULT_SETTINGS, setPath({}, s.path, o.value))), `${s.path}=${o.value}`).not.toThrow();
    }
  });

  it('applies a preset on top of what is there, and takes it out again', () => {
    const noFun = PROFILE_PRESETS.find((p) => p.id === 'no-fun')!;
    const start = { ai: { temperature: 0.2 }, appearance: { splash: false } };
    const on = applyPreset(noFun, start, ['ai.temperature'], true);
    expect(on.settings).toEqual({ ai: { temperature: 0.2 }, appearance: { splash: false, easterEggs: false, gooseVisits: false, splashSound: false } });
    expect(on.locked).toEqual(['ai.temperature', 'appearance.easterEggs', 'appearance.gooseVisits']);
    expect(presetApplied(noFun, on.settings, on.locked)).toBe(true);
    const off = applyPreset(noFun, on.settings, on.locked, false);
    expect(off).toEqual({ settings: start, locked: ['ai.temperature'] });
    expect(presetApplied(noFun, off.settings, off.locked)).toBe(false);
  });

  it('removes a setting without leaving empty objects behind', () => {
    expect(setPath({ mesh: { assist: { offer: 'off' } } }, 'mesh.assist.offer', undefined)).toEqual({});
    expect(setPath({}, 'backup.retention', 14)).toEqual({ backup: { retention: 14 } });
  });
});
