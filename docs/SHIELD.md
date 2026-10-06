# FBRX Shield and the antivirus choice

**Stronghold → FBRX Shield** is where you see and choose what protects the computer from malware:

* **FBRX Shield**: FBRX's own antivirus (below).
* **Microsoft Defender**: built into Windows; also Microsoft Defender for Endpoint on a Mac or Linux computer that
  has it.
* **An antivirus already installed**: Sophos, CrowdStrike Falcon, SentinelOne, ESET, Bitdefender, Malwarebytes,
  Kaspersky, Norton, McAfee/Trellix, Trend Micro, Webroot, Avast, AVG, Avira, WithSecure, Intego, Cylance, or any
  other product registered with Windows Security Center.
* **Automatic** (the default): an antivirus you installed that is on; otherwise Microsoft Defender when it is protecting
  Windows; otherwise an installed antivirus even if it is off (so you hear that it is off); otherwise FBRX Shield.

FBRX then shows that antivirus's status everywhere (FBRX Shield, Security, FBRX Glass, the agent, FBRX Command), runs
its scans where it can, and raises an **Antivirus needs attention** alert when it is off, out of date or gone.

## What FBRX can see and do with each

| | Status | Scans from FBRX |
| --- | --- | --- |
| FBRX Shield | Everything | Quick, full, a folder; progress as it goes |
| Microsoft Defender on Windows | Real-time protection, definitions age, last scan, active threats | Quick, full, a folder (`MpCmdRun`); definitions update; Defender's threat history in Security |
| Microsoft Defender for Endpoint (Mac, Linux) | Real-time protection, definitions (`mdatp health`) | Quick, full, a folder (`mdatp scan`) |
| Sophos on Windows / Linux | On and up to date (Windows Security Center) | A folder or the quick/full locations (`SophosInterceptXCLI scan --noui`, `avscanner`) |
| Other products on Windows | On and up to date (Windows Security Center) | In the product's own app |
| Other products on a Mac or Linux | Installed (FBRX cannot read their status) | In the product's own app |

**FBRX Shield can always give a second opinion**: quick scan or a folder with FBRX Shield, whatever is active.

Windows Security Center is not on Windows Server; there FBRX recognizes Microsoft Defender and ClamAV only.

## FBRX Shield

Layers, in order:

1. **The EICAR test file**, the standard harmless file antivirus products treat as malware, so you can check it works.
2. **A threat database** of known-malware fingerprints (SHA-256), updated every day from a public feed (by default
   abuse.ch MalwareBazaar's recent additions). If the feed asks for a key, add your free abuse.ch Auth-Key in
   Credentials as `ABUSECH_AUTH_KEY`. You can point it at another list (one SHA-256 per line) or import a list.
3. **FBRX's own rules** for suspicious files:
   * programs disguised as documents (`invoice.pdf.exe`) or with hidden right-to-left characters in the name;
   * scripts that delete backups and recovery points, turn off or exclude antivirus, download and run code, hide
     PowerShell in Base64, decode and run hidden code, or abuse certutil, bitsadmin, mshta or regsvr32;
   * cryptocurrency miner settings;
   * from the internet (Downloads, the desktop, or Windows' Mark of the Web): risky file types (scripts, shortcuts,
     disk images, screen savers…), Office documents with macros, and small archives that hide a script or a disguised
     program.
4. **Endpoint Ultra**: **ClamAV** (when installed) as a second engine, and **VirusTotal** for suspicious files (with a
   `VIRUSTOTAL_API_KEY` in Credentials: three or more engines calling it malicious makes it malware).

What happens to a finding:

* **Malware** (and the test file) goes into **quarantine** straight away (you can turn that off): moved into FBRX's
  data folder, encrypted with its own key so it cannot run and other antivirus products do not trip over it.
* **Suspicious** files wait for you: **Quarantine**, **Trust** (FBRX Shield leaves it and stops reporting it), or
  **Delete**. **Ask Fabrix** explains a finding without opening the file.
* From quarantine: **Restore** (put back next to its old name if something else is there now, checked against its
  fingerprint, and trusted from then on) or **Delete** for good.
* Each finding raises a **FBRX Shield found a threat** alert (desktop, phone, e-mail, webhooks and FBRX Command, as
  set in Alerts).

**Download checks** look at new files in Downloads and on the desktop as soon as they stop growing (unfinished browser
downloads are skipped). **Quick scan**: Downloads, the desktop, the temp folder and the startup folders. **Full scan**:
your home folder, the temp folder and the startup folders. Photos, music and video are listed but not fingerprinted,
and files over 100 MB are not fingerprinted. **Skip these folders** leaves folders out of scans and download checks.

FBRX Shield checks downloads, scans on demand and quarantines; it does not (yet) block programs as they start. On
Windows, Microsoft Defender keeps running underneath, as Windows requires; on a Mac, macOS's own protection keeps
running too.

### Editions

Endpoint Basic and Ultra both have FBRX Shield's download checks, scans, threat database, rules and quarantine, and
the choice of antivirus. **Endpoint Ultra** adds scheduled scans (a quick scan every day or week) and the second
engines (ClamAV, VirusTotal). Student and child computers (FBRX OS Education and Home) run the download checks in the
background without the page; the school or family chooses their antivirus from FBRX Command.

## The agent

| Tool | Risk | What it does |
| --- | --- | --- |
| `shield.status` | read | Which antivirus protects the computer, its state and problems, and FBRX Shield's recent findings |
| `shield.scan` | read | Scans a file or folder with FBRX Shield and reports (moves nothing) |
| `shield.quarantine` | write | Quarantines a finding (with approval) |

## Organizations (FBRX Command)

* Every computer reports its antivirus with its heartbeat: device detail shows **Antivirus** (name and state), and
  the Health column says **Antivirus at risk** or **Antivirus needs attention**.
* Choose the antivirus for a group in a configuration profile and lock it:

  ```json
  { "protection": { "provider": "product:sophos" } }
  ```

  with `protection.provider` in the locked settings. Values: `auto`, `shield`, `defender`, `product:<id>` (`sophos`,
  `crowdstrike`, `sentinelone`, `eset`, `bitdefender`, `malwarebytes`, `kaspersky`, `norton`, `mcafee`,
  `trendmicro`, `webroot`, `avast`, `avg`, `avira`, `withsecure`, `intego`, `cylance`). FBRX Shield's settings live
  under `protection.shield` (for example `"exclusions"` or `"feedUrl"`).
* FBRX Shield findings reach FBRX Command through the alert channel for the organization.

## API

`protection.status`, `protection.setProvider`, `protection.scan` (`engine: "active"` or `"shield"`),
`protection.cancelScan`, `protection.job`, `shield.detections`, `shield.act` (`quarantine`, `restore`, `delete`,
`allow`), `shield.updateSignatures`, `shield.importSignatures`, `shield.check`; events `protection.changed`,
`protection.scan`, `shield.detected`. Choosing the antivirus, starting scans and acting on findings are for the
person at the computer only.
