/*
 * The FBRX command library in the Library: FBRX/1 (the command line of the FBRX app on this computer), and the
 * commands on FBRX Server and FBRX Gate (the same lists the Terminal's device guides show). Steps may contain <kbd>
 * and <code> only.
 */
import { deviceProfile } from '@fbrx/shared';
import type { IconName } from '@fbrx/ui';

export interface FbrxCommand {
  cmd: string;
  what: string;
  /** Changes something. */
  danger?: boolean;
}

export interface FbrxCommandSet {
  id: string;
  title: string;
  /** Where these commands run. */
  where: string;
  icon: IconName;
  /** fbrx1: "Try it" opens FBRX/1 with the command typed in; server: copy it and open a device console. */
  kind: 'fbrx1' | 'server';
  groups: Array<{ name: string; items: FbrxCommand[] }>;
}

const FBRX1: FbrxCommandSet = {
  id: 'fbrx1',
  title: 'FBRX/1',
  where: 'This computer: Terminal → FBRX/1. Like the command line of a switch or firewall, for FBRX itself.',
  icon: 'terminal',
  kind: 'fbrx1',
  groups: [
    {
      name: 'Look',
      items: [
        { cmd: 'show version', what: 'Product, version and license' },
        { cmd: 'show system status', what: 'Services, vault, organization, the agent and the emergency stop' },
        { cmd: 'show system resources', what: 'Processor, memory and disks right now' },
        { cmd: 'show services', what: 'Every FBRX service and its state' },
        { cmd: 'show alerts', what: 'Recent alerts' },
        { cmd: 'show approvals', what: 'Actions waiting for your approval' },
        { cmd: 'show license', what: 'License details' },
        { cmd: 'show ai providers', what: 'AI providers and whether they are ready' },
        { cmd: 'show network interfaces', what: 'Adapters, addresses and MACs' },
        { cmd: 'show network devices', what: 'Devices from the last network scan' },
        { cmd: 'show consoles', what: 'Open device consoles' },
        { cmd: 'show tasks', what: 'Open tasks' },
        { cmd: 'show audit 20', what: 'The last 20 audited actions' },
        { cmd: 'show log 200', what: 'The last 200 lines of FBRX\'s log' },
        { cmd: 'show configuration', what: 'Settings in use (add a section: show configuration ai)' },
      ],
    },
    {
      name: 'Pipes',
      items: [
        { cmd: 'show services | except running', what: 'Only what is not running' },
        { cmd: 'show log 200 | match error', what: 'Only lines that mention an error' },
        { cmd: 'show network devices | count', what: 'How many lines' },
        { cmd: 'show audit 5 | display json', what: 'As JSON, for scripts and tickets' },
        { cmd: 'show configuration | display set', what: 'Every setting as a set command, to copy to another computer' },
      ],
    },
    {
      name: 'Do',
      items: [
        { cmd: 'request ai stop', what: 'Emergency stop: halt every AI action now', danger: true },
        { cmd: 'request ai resume', what: 'Lift the emergency stop' },
        { cmd: 'request backup now', what: 'Back up this computer (uses the saved backup passphrase)' },
        { cmd: 'request network scan', what: 'Look for devices on the network (about a minute)' },
        { cmd: 'request service restart agent', what: 'Restart one FBRX service (names from show services)', danger: true },
        { cmd: 'request alerts mark-read', what: 'Mark every alert read' },
        { cmd: 'ping 1.1.1.1 count 4', what: 'Is the internet there?' },
      ],
    },
    {
      name: 'Configure',
      items: [
        { cmd: 'configure', what: 'Enter configuration mode: set, delete, show, commit, rollback, exit' },
        { cmd: 'set appearance preset neon', what: 'Change a setting (in configuration mode)' },
        { cmd: 'show | compare', what: 'What you changed, before committing' },
        { cmd: 'commit check', what: 'Check the changes without applying them' },
        { cmd: 'commit', what: 'Apply the changes', danger: true },
        { cmd: 'rollback', what: 'Throw the changes away' },
      ],
    },
  ],
};

/** The server-side sets come from the device guides, so the Library and the Terminal never disagree. */
function fromGuide(id: string, title: string, where: string, icon: IconName): FbrxCommandSet {
  const p = deviceProfile(id);
  return { id, title, where, icon, kind: 'server', groups: (p?.commands ?? []).map((g) => ({ name: g.group, items: g.items.map((i) => ({ cmd: i.cmd, what: i.what, danger: i.danger })) })) };
}

export const FBRX_COMMAND_SETS: FbrxCommandSet[] = [
  FBRX1,
  fromGuide('fbrx-server', 'FBRX Server', 'On the server: its own screen, or SSH (Terminal → Device consoles). fbrx-server help lists them all.', 'server'),
  fromGuide('fbrx-gate', 'FBRX Gate', 'On a server with the gate role, as root. sudo fbrx-gate help lists them all.', 'network'),
];

export interface FbrxHowto {
  id: string;
  t: string;
  s: string;
  steps: string[];
  go?: string;
  ask?: string;
}

export const FBRX_HOWTOS: FbrxHowto[] = [
  {
    id: 'cli-health',
    t: 'See everything FBRX is doing, in one look',
    s: 'Services, the agent, alerts and approvals from the command line',
    steps: ['Open Terminal → FBRX/1.', 'Type <code>show system status</code> and press <kbd>Enter</kbd>.', 'Only what is wrong: <code>show services | except running</code>.', 'Then <code>show alerts</code> and <code>show approvals</code> for anything waiting on you.'],
    go: 'fbrx1',
  },
  {
    id: 'cli-stop',
    t: 'Stop the AI right now',
    s: 'The emergency stop, from the keyboard',
    steps: ['In FBRX/1, type <code>request ai stop</code>: every AI action stops and waiting approvals are refused.', 'The red stop button in the top bar does the same.', 'When you are ready: <code>request ai resume</code>.'],
    go: 'fbrx1',
  },
  {
    id: 'cli-copy-settings',
    t: 'Copy your settings to another computer',
    s: 'Settings as set commands, pasted and committed',
    steps: [
      'On this computer, in FBRX/1: <code>show configuration | display set</code>. Copy the lines you want.',
      'On the other computer, in FBRX/1: <code>configure</code>, paste the lines, then <code>show | compare</code> to check.',
      '<code>commit</code> applies them; <code>rollback</code> throws them away. <code>exit</code> leaves configuration mode.',
      'For a whole organization, FBRX Command profiles do this for every computer at once.',
    ],
    go: 'fbrx1',
  },
  {
    id: 'cli-try',
    t: 'Try a setting without keeping it',
    s: 'Change, compare, then throw it away',
    steps: ['<code>configure</code>', '<code>set appearance density compact</code>', '<code>show | compare</code> shows the change as a set line.', '<code>rollback</code> forgets it; nothing changed.'],
    go: 'fbrx1',
  },
  {
    id: 'server-find',
    t: 'Find FBRX Server\'s web console',
    s: 'Its address and the certificate to trust',
    steps: [
      'On the server (its screen or SSH): <code>fbrx-server status</code>.',
      'Open the Console address in your browser, or add it under Lab → FBRX Server.',
      'The first time, compare the certificate fingerprint your browser shows with the one <code>fbrx-server status</code> printed.',
      'Never set up yet? <code>sudo fbrx-server setup-code</code> gives the code the console asks for.',
    ],
    go: 'server',
  },
  {
    id: 'server-locked-out',
    t: 'Get back into FBRX Server after a forgotten password',
    s: 'From the server\'s own command line',
    steps: ['Log in on the server (its screen or SSH) with the administrator you made at install.', '<code>sudo fbrx-server users</code> lists who can sign in.', '<code>sudo fbrx-server reset-password NAME</code> prints a new password for NAME.', 'Need another administrator? <code>sudo fbrx-server create-admin</code>.'],
    go: 'consoles',
  },
  {
    id: 'server-role',
    t: 'Add a role to FBRX Server (AI, gate, MiniDome)',
    s: 'Run the installer again with the roles you want',
    steps: [
      'Copy the newest FBRX Server bundle (Releases page, or Lab → FBRX Server) to the server and unpack it.',
      'In its folder: <code>sudo bash install.sh --roles virtual,ai,gate,minidome --yes</code> (list every role the server should have).',
      'Your machines, users and gate configuration are kept.',
      '<code>fbrx-server status</code> shows the roles in use.',
    ],
    go: 'server',
  },
  {
    id: 'gate-safe-change',
    t: 'Change FBRX Gate without locking yourself out',
    s: 'A commit that undoes itself unless you keep it',
    steps: [
      'Edit the candidate: <code>sudo fbrx-gate set networks lan dhcp end 192.168.1.200</code>.',
      'Check it: <code>sudo fbrx-gate check</code>, then <code>sudo fbrx-gate compare</code>.',
      'Apply with a safety net: <code>sudo fbrx-gate commit confirmed 5</code>.',
      'Still connected? <code>sudo fbrx-gate confirm</code>. If you got cut off, wait five minutes: the gate rolls back by itself.',
    ],
    go: 'consoles',
  },
  {
    id: 'gate-undo',
    t: 'Undo a gate change from last week',
    s: 'Every commit is kept',
    steps: ['<code>sudo fbrx-gate history</code> lists commits, newest first, with their comments.', '<code>sudo fbrx-gate rollback 12</code> goes back to commit 12 (a new commit you can undo too).', 'Waiting on a confirmed commit? <code>sudo fbrx-gate rollback now</code> undoes it at once.'],
    go: 'consoles',
  },
  {
    id: 'gate-vm-switch',
    t: 'Put a virtual machine on your network',
    s: 'A gate network virtual machines can plug into, like a virtual switch',
    steps: [
      '<code>sudo fbrx-gate set networks lan vmSwitch true</code>, then <code>sudo fbrx-gate commit confirmed 5</code> and <code>sudo fbrx-gate confirm</code>.',
      'In FBRX Virtual, open the machine → Settings → Network → Move it, and pick the LAN switch.',
      'The machine gets an address from the gate, next to your other devices: <code>sudo fbrx-gate leases</code> shows it.',
    ],
    go: 'server',
  },
  {
    id: 'console-save',
    t: 'Keep your switches and firewalls one click away',
    s: 'Saved connections in Device consoles',
    steps: [
      'Terminal → Device consoles → New connection (or Connect on a device in Network Center → Devices).',
      'Tick Remember the password if you want: it is encrypted in your vault.',
      'It appears under Saved connections, with its guide. Edit it to give it a name and notes; a key means one click connects.',
    ],
    go: 'consoles',
  },
  {
    id: 'console-fbrx-guide',
    t: 'Get FBRX\'s commands next to a server\'s console',
    s: 'The FBRX Server and FBRX Gate guides',
    steps: ['Connect to the server in Terminal → Device consoles.', 'Device guide: FBRX Server or FBRX Gate & MiniDome (picked by itself when the server\'s name has fbrx in it).', 'Click a command in the guide to type it; ones that change something ask first.'],
    go: 'consoles',
  },
];

/** What unlocks the command library in Fun Mode: talking to the Library like a command line. */
export const FBRX_CLI_TRIGGER = /^\s*(show\s+(commands|fbrx|version)|enable|conf(igure)?(\s+t(erminal)?)?|fbrx(-server|-gate)?\s+help)\s*$/i;
