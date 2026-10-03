# Third-party components in voice

Voice in FBRX OS runs entirely on the computer with these components. Models are downloaded on request from Hugging
Face; code and data are bundled with the app.

| Component | Used for | License | Where |
| --- | --- | --- | --- |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Running the speech models | Apache-2.0 | Bundled (npm `@huggingface/transformers`) |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | The engine under Transformers.js (WebAssembly) | MIT | Bundled (`dist/ort`) |
| [Whisper](https://github.com/openai/whisper), ONNX conversions by [Xenova](https://huggingface.co/Xenova) | Speech to text | MIT | Downloaded (`Xenova/whisper-*`) |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), ONNX conversion by [onnx-community](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | The natural voices | Apache-2.0 | Downloaded (model, tokenizer and voice files) |
| [HeadTTS](https://github.com/met4citizen/HeadTTS) language modules | English text to Kokoro phonemes (dictionary lookup and NRL letter-to-sound rules) | MIT, © 2025 Mika Suominen | Vendored in `apps/desktop/src/renderer/voice/kokoro/` with its license |
| [CMU Pronouncing Dictionary](http://www.speech.cs.cmu.edu/cgi-bin/cmudict) 0.7b, in Kokoro phonemes (from HeadTTS) | Pronunciations | BSD-style, © 1993-2015 Carnegie Mellon University (notice kept at the top of the file) | Bundled (`kokoro/en-us.txt.gz`) |

No GPL component is included: the eSpeak NG phonemizer that other Kokoro front ends use is deliberately left out.
