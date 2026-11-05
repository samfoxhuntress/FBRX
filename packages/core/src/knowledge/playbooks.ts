/**
 * What to do when FBRX itself misbehaves: one playbook per kind of trouble, written for the agent. Each says what to
 * look at (fbrx.doctor runs those checks) and which fixes fbrx.fix can apply after the person agrees.
 */

export interface Playbook {
  id: string;
  title: string;
  /** Words people use for it, for the search. */
  symptoms: string;
  text: string;
  /** Fixes fbrx.fix knows that often help (see FIXES). */
  fixes: string[];
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'slow-ai',
    title: 'The AI is slow to answer',
    symptoms: 'slow ai, takes forever, long time to answer, laggy agent, thinking forever, model slow, tokens per second',
    text: [
      'A local model is only as quick as the computer: the bigger the model and the longer the context window, the slower each answer, and a model that does not fit in memory is far slower still.',
      'Check with fbrx.doctor: the model size against the memory, the context window (Settings → AI → Local runtime), and whether something else is busy (an FBRX Shield scan, another program using the processor).',
      'Fixes: a smaller model (Settings → AI → Models, a 3–8 billion parameter model for most laptops), a shorter context window (lower-context), stopping a running scan (cancel-scan), or switching to a cloud AI provider for long tasks. Mesh Assist can borrow another computer’s AI.',
    ].join('\n'),
    fixes: ['lower-context', 'cancel-scan', 'unload-model'],
  },
  {
    id: 'slow-app',
    title: 'FBRX itself feels slow or uses a lot of memory',
    symptoms: 'fbrx slow, laggy, freezing, high memory, high cpu, sluggish, hangs, not responding, fan loud',
    text: [
      'FBRX does most of its work in the background: the local AI model (the biggest user of memory), FBRX Shield scans, the system monitor and the database.',
      'Check with fbrx.doctor: memory use, whether a model is loaded, a scan running, the size of FBRX’s database, and a long list of FBRX Shield findings.',
      'Fixes: unload the local model when it is not needed (unload-model), stop a scan (cancel-scan), clear FBRX Shield’s list of findings it no longer flags (recheck-shield), and tidy the database (compact-database). Restarting a failing service (restart-service) helps when one keeps failing.',
    ].join('\n'),
    fixes: ['unload-model', 'cancel-scan', 'recheck-shield', 'compact-database'],
  },
  {
    id: 'ai-not-answering',
    title: 'The AI does not answer or shows an error',
    symptoms: 'ai not working, no answer, error, provider error, api key, offline, cannot reach, failed to load model, emergency stop',
    text: [
      'Common causes: the emergency stop is on, the local runtime is not running or its model failed to load, a cloud provider has no API key or no internet, or the organization’s policy blocks cloud AI.',
      'Check with fbrx.doctor and fbrx.status. A model that failed to load for lack of memory needs a smaller model; a damaged download needs downloading again (Settings → AI → Models).',
      'Fixes: lift the emergency stop with the Resume button at the top of FBRX (the AI cannot do that itself), restart the local runtime (restart-service:runtime).',
    ].join('\n'),
    fixes: ['restart-service:runtime'],
  },
  {
    id: 'too-many-notifications',
    title: 'Too many notifications, or the same one twice',
    symptoms: 'notifications spam, too many alerts, pop ups, notification twice, duplicate notification, sound, mute',
    text: [
      'Alerts → Notifications decides what pops up: a switch per kind (alerts, messages, FBRX Mesh, calendar…), where they show (Automatic shows each one in one place: inside FBRX while you use it, otherwise in Windows notifications), and the sound.',
      'FBRX Shield tells about a whole scan in one alert. Quiet hours (Alerts → Delivery) hold back the ones that are not critical.',
    ].join('\n'),
    fixes: [],
  },
  {
    id: 'shield-false-positives',
    title: 'FBRX Shield flags files that are fine',
    symptoms: 'false positive, shield flagged, trust, too many findings, suspicious files, quarantine wrong file, antivirus blocking',
    text: [
      'FBRX Shield never looks at FBRX’s own files or at code installed by package managers. For other files that are fine: Trust (one), right-click → trust its whole folder, or Trust all suspicious (malware always waits one by one).',
      'Folders can be excluded in FBRX Shield’s settings. "Check the list again" clears findings the current rules no longer flag (recheck-shield).',
    ].join('\n'),
    fixes: ['recheck-shield'],
  },
  {
    id: 'folder-access',
    title: 'The AI cannot open a file or folder',
    symptoms: 'cannot access folder, outside the allowed folders, permission denied, other drive, network share, d drive, external drive',
    text: [
      'The AI only uses the folders listed in Governance → Folders your AI can use. For another drive or a network share, ask the person with files.request_access: they pick the folder or say no. On computers an organization manages, FBRX Command decides.',
    ].join('\n'),
    fixes: [],
  },
  {
    id: 'service-failing',
    title: 'A part of FBRX keeps failing',
    symptoms: 'service failing, keeps failing, degraded, crashed, watchdog, not running, error in logs',
    text: [
      'FBRX runs as services (the runtime, the mesh, the local API, alerts…) watched by a watchdog that restarts them. fbrx.doctor lists any that are failing, with their last error, and the recent errors in FBRX’s log.',
      'Fix: restart that service (restart-service:<name>). If it keeps failing, the error says why (a port in use, a damaged file); Settings → About → Logs has the full log.',
    ].join('\n'),
    fixes: ['restart-service'],
  },
  {
    id: 'mesh-trouble',
    title: 'FBRX Mesh does not connect',
    symptoms: 'mesh not connecting, peer offline, pairing failed, device not found, mesh assist',
    text: [
      'FBRX Mesh needs both computers on, FBRX Mesh turned on (Orbit → Mesh), and the mesh port allowed through the firewall. Pairing codes expire after a few minutes; too many wrong codes pause pairing.',
      'Fix: restart the mesh service (restart-service:mesh).',
    ].join('\n'),
    fixes: ['restart-service:mesh'],
  },
  {
    id: 'updates',
    title: 'Updating FBRX, FBRX Command and FBRX Server',
    symptoms: 'update, new version, upgrade, how to update, out of date, release',
    text: [
      'FBRX Endpoint checks this repository’s release list and offers new versions (Settings → About), or FBRX Command pushes them.',
      'FBRX Command shows when a newer version is out and can update itself (FBRX Command → Overview), or run Install FBRX Command again from the new FBRX folder.',
      'FBRX Server: sudo fbrx-server update check, then sudo fbrx-server update commit (update rollback goes back).',
    ].join('\n'),
    fixes: [],
  },
  {
    id: 'image-backup',
    title: 'Whole-computer image backups fail',
    symptoms: 'image backup failed, fbrx time, wbadmin, system image, backup drive, network folder backup',
    text: [
      'Backup & restore → Whole computer shows what Windows said. Common causes: the drive is not NTFS or too small, the network folder is unreachable or its account cannot write, or the computer went to sleep.',
      'An FBRX Server’s connection code fills in the folder and account. The task runs as the system, so the network folder must allow that account.',
    ].join('\n'),
    fixes: [],
  },
  {
    id: 'vault-locked',
    title: 'Credentials are locked',
    symptoms: 'vault locked, credentials locked, api key missing, unlock, password on start',
    text: 'Credentials (the vault) can be locked with a password on start. Locked, tools that need keys cannot use them. Unlock it in Credentials.',
    fixes: [],
  },
  {
    id: 'memory',
    title: 'What the AI remembers about you',
    symptoms: 'memory, remember me, forget, what do you know about me, privacy, personal information',
    text: [
      'Settings → Memory shows what the AI remembers (long term) and the last day of conversations it keeps in mind (short term), and lets you forget any of it. It never keeps government ID numbers, bank details or passwords, and never sends personal details to the internet.',
    ].join('\n'),
    fixes: [],
  },
];

export interface FixInfo {
  id: string;
  label: string;
  /** What it changes, in words, for the approval. */
  detail: string;
}

/** The fixes fbrx.fix can apply (restart-service:<name> takes a service's name). */
export const FIXES: FixInfo[] = [
  { id: 'restart-service', label: 'Restart a service', detail: 'Stops and starts one part of FBRX (restart-service:<name>, for example restart-service:runtime).' },
  { id: 'cancel-scan', label: 'Stop the running scan', detail: 'Stops the antivirus scan that is running now; what it found so far stays.' },
  { id: 'recheck-shield', label: 'Clear findings FBRX Shield no longer flags', detail: 'Looks at the waiting findings again and clears the ones the current rules do not flag.' },
  { id: 'unload-model', label: 'Unload the local AI model', detail: 'Stops the local runtime and frees its memory; it starts again the next time the AI is asked something.' },
  { id: 'lower-context', label: 'Shorten the local model’s context window', detail: 'Sets the built-in runtime’s context window to 8,192 tokens (quicker answers, shorter memory of the conversation).' },
  { id: 'compact-database', label: 'Tidy FBRX’s database', detail: 'Rebuilds FBRX’s database file to give back unused space (a few seconds; nothing is deleted).' },
];
