# Bible texts for scripture.lookup

Not shipped (electron-builder copies only `*.jsonl.br` and `*-build.json`). Each `<id>.jsonl.br` is the Brotli
(quality 11) of the verified JSONL of the same name in the FBRX-LLM repository, `data/scripture/` at commit `ddbc0bf`
(2026-11-15), with its build manifest beside it. The SHA-256 of each uncompressed file is fixed in
`packages/core/src/scripture/scripture.ts` (from the manifests' `output_sha256`), so a changed file is refused; to take
a new build, compress it the same way and change the checksum there. Sources and licenses: `docs/THIRD_PARTY.md`.
