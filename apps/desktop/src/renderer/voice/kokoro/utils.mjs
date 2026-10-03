// The parts of HeadTTS's utils.mjs the language modules use (MIT License, see LICENSE-HeadTTS.txt).

export function isNode() {
  return false;
}

export function deepCopy(o) {
  return JSON.parse(JSON.stringify(o));
}

export function trace(...outputs) {
  console.log('HeadTTS', ...outputs);
}
