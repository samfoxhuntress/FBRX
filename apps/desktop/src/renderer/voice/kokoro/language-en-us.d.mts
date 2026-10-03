/** English text to Kokoro phonemes (vendored HeadTTS module). */
export class Language {
  constructor(settings?: { trace?: boolean } | null);
  dictionary: Record<string, string[]> | null;
  addToDictionary(line: string): void;
  generate(input: string): { phonemes: string[] };
}
