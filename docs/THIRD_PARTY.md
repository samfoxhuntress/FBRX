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

# Third-party components in Calendar

| Component | Used for | License | Where |
| --- | --- | --- | --- |
| [ical.js](https://github.com/kewisch/ical.js) | Reading calendar links (iCalendar): repeating events, time zones | MPL-2.0 | Bundled (npm `ical.js`, unmodified) |

# Third-party data and components in FBRX Shield

| Component | Used for | License | Where |
| --- | --- | --- | --- |
| [abuse.ch MalwareBazaar](https://bazaar.abuse.ch/) SHA-256 exports | The default threat database feed (fingerprints only, downloaded at run time) | CC0 | Downloaded; the feed address can be changed |
| [ClamAV](https://www.clamav.net/) | Optional second engine (Endpoint Ultra) | GPL-2.0 | Not bundled: used only when installed separately, run as its own program |

# Third-party components in FBRX Server and FBRX Virtual

| Component | Used for | License | Where |
| --- | --- | --- | --- |
| [noVNC](https://github.com/novnc/noVNC) | Virtual machines' screens in the browser | MPL-2.0 | Bundled in the console (npm `@novnc/novnc`, unmodified) |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | Reading libvirt's XML | MIT | Bundled (npm `fast-xml-parser`) |
| [Node.js](https://nodejs.org/) | FBRX Virtual's runtime | MIT | Downloaded by the installer (packed into the ISO) |
| [Debian](https://www.debian.org/) 13 installer | The base of the FBRX Server ISO | DFSG-free (mostly GPL) | Downloaded from Debian when the ISO is built; FBRX adds files next to it and changes only the boot menus |
| QEMU, libvirt, OVMF, swtpm | The hypervisor, UEFI firmware, software TPM | GPL-2.0 / LGPL-2.1 / BSD-2-Clause-Patent / BSD-3-Clause | Installed from Debian's packages, run as their own programs |
| [PCI ID Repository](https://pci-ids.ucw.cz/) (`pci.ids`) | Device names in the hardware map | GPL-2.0+ / BSD-3-Clause | Read from the server's pciutils package at run time, not bundled |
| nftables, dnsmasq, systemd-networkd, iproute2 (tc) | FBRX Gate: the firewall, DHCP and DNS, ports and VLANs, traffic shaping | GPL-2.0 / GPL-2.0-or-later / LGPL-2.1+ / GPL-2.0 | Installed from Debian's packages (gate role), configured by FBRX Gate, run as their own programs |
| wireguard-tools | FBRX Gate's VPN keys and status (the VPN itself is in the Linux kernel) | GPL-2.0 | Installed from Debian's package (gate role). WireGuard is a registered trademark of Jason A. Donenfeld; FBRX Gate uses it and is not affiliated with it |
| conntrack-tools | FBRX MiniDome: following new connections | GPL-2.0 | Installed from Debian's package (minidome role), run as its own program |
| [qrcode](https://github.com/soldair/node-qrcode) | QR codes for VPN devices | MIT | Bundled (npm `qrcode`) |
