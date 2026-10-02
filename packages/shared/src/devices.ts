/**
 * Network device profiles for the device console: how to recognize a vendor's gear from a network scan, how to log
 * in, the commands people use most and where the official documentation lives. Shared by the desktop console (the
 * guide next to the terminal) and the agent (so its help matches what the person sees).
 */

export interface DeviceCliCommand {
  cmd: string;
  /** What it does, in plain language. */
  what: string;
  /** Changes or restarts the device: the console asks before sending it. */
  danger?: boolean;
}

export interface DeviceProfile {
  id: string;
  name: string;
  /** Matched against the MAC vendor, model and device name from a scan. */
  match: RegExp;
  kind: string;
  /** Usual SSH user name when the device has a well-known default (always change default passwords). */
  defaultUser?: string;
  /** SSH port when the vendor does not use 22. */
  sshPort?: number;
  /** Older firmware only speaks SHA-1 key exchange and CBC ciphers. */
  legacyCrypto?: boolean;
  /** Ports of the device's web admin page, in order of preference. */
  webPorts?: number[];
  login: string[];
  /** Turns off "--More--" paging so long output scrolls (and so the agent reads it in one go). */
  noPaging?: string;
  commands: Array<{ group: string; items: DeviceCliCommand[] }>;
  docs: Array<{ label: string; url: string }>;
}

export const DEVICE_PROFILES: DeviceProfile[] = [
  {
    id: 'ubiquiti',
    name: 'Ubiquiti UniFi / EdgeMAX',
    match: /ubiquiti|unifi|ubnt|edgerouter|\bu6\b|\busw\b|\budm\b|\buxg\b/i,
    kind: 'Access point, switch or gateway',
    defaultUser: 'ubnt',
    webPorts: [443, 8443, 80],
    login: [
      'Devices not yet adopted use the factory login (ubnt / ubnt, or ui / ui on newer models).',
      'Adopted devices use the "Device SSH Authentication" user and password from UniFi Network → Settings → System → Advanced.',
      'EdgeRouters use the user you created in the EdgeOS web interface.',
    ],
    commands: [
      {
        group: 'UniFi devices',
        items: [
          { cmd: 'info', what: 'Model, firmware, IP and the controller it reports to' },
          { cmd: 'set-inform http://CONTROLLER:8080/inform', what: 'Point the device at your UniFi controller for adoption (replace CONTROLLER)', danger: true },
          { cmd: 'mca-cli-op info', what: 'Detailed device status (newer firmware)' },
          { cmd: 'cat /var/log/messages | tail -n 50', what: 'The last 50 log lines' },
          { cmd: 'reboot', what: 'Restart the device', danger: true },
        ],
      },
      {
        group: 'EdgeRouter (EdgeOS)',
        items: [
          { cmd: 'show interfaces', what: 'Every port with its address and state' },
          { cmd: 'show ip route', what: 'The routing table' },
          { cmd: 'show configuration commands', what: 'The whole configuration as set commands' },
          { cmd: 'show dhcp leases', what: 'Devices that got an address from the router' },
          { cmd: 'configure', what: 'Enter configuration mode (commit, save and exit when done)', danger: true },
        ],
      },
    ],
    docs: [
      { label: 'Ubiquiti Help Center', url: 'https://help.ui.com' },
      { label: 'Ubiquiti Community', url: 'https://community.ui.com' },
    ],
  },
  {
    id: 'sophos',
    name: 'Sophos Firewall',
    match: /sophos|cyberoam/i,
    kind: 'Firewall',
    defaultUser: 'admin',
    legacyCrypto: true,
    webPorts: [4444, 443],
    login: [
      'Log in as admin with the web admin password. You land in a numbered menu.',
      'Choose 4 for the Device Console (Sophos commands) or 5 then 3 for the Advanced Shell (Linux tools).',
      'Type exit to go back to the menu.',
    ],
    commands: [
      {
        group: 'Device Console (menu 4)',
        items: [
          { cmd: 'system diagnostics show version-info', what: 'Firmware version and build' },
          { cmd: "drop-packet-capture 'host 192.168.1.10'", what: 'Show packets the firewall drops for one address (Ctrl+C to stop)' },
          { cmd: 'system ha show details', what: 'High-availability status' },
        ],
      },
      {
        group: 'Advanced Shell (menu 5 → 3)',
        items: [
          { cmd: 'service -S', what: 'Every service and whether it is running' },
          { cmd: "tcpdump -ni any host 192.168.1.10", what: 'Live packets to and from one address (Ctrl+C to stop)' },
          { cmd: 'ifconfig', what: 'Interfaces and addresses' },
          { cmd: 'df -h', what: 'Free space on the firewall' },
        ],
      },
    ],
    docs: [
      { label: 'Sophos documentation', url: 'https://docs.sophos.com' },
      { label: 'Sophos Community', url: 'https://community.sophos.com' },
    ],
  },
  {
    id: 'meraki',
    name: 'Cisco Meraki',
    match: /meraki/i,
    kind: 'Cloud-managed network device',
    login: ['Meraki devices have no command line: manage them in the Meraki dashboard.', 'The local status page is at http://my.meraki.com from a device behind it.'],
    commands: [],
    docs: [{ label: 'Meraki documentation', url: 'https://documentation.meraki.com' }],
  },
  {
    id: 'cisco',
    name: 'Cisco IOS / IOS XE',
    match: /cisco(?![- ]linksys)/i,
    kind: 'Switch or router',
    legacyCrypto: true,
    webPorts: [443, 80],
    login: ['Log in with the local user (or RADIUS / TACACS account).', 'Type enable and the enable secret for privileged commands; the prompt changes from > to #.'],
    noPaging: 'terminal length 0',
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'enable', what: 'Privileged mode (needed for most show commands)' },
          { cmd: 'show version', what: 'Model, IOS version, uptime and serial number' },
          { cmd: 'show ip interface brief', what: 'Every interface with its address and status' },
          { cmd: 'show interfaces status', what: 'Switch ports: connected, speed, duplex and VLAN' },
          { cmd: 'show vlan brief', what: 'VLANs and which ports are in them' },
          { cmd: 'show mac address-table', what: 'Which device (MAC) is on which port' },
          { cmd: 'show cdp neighbors', what: 'Cisco devices plugged into this one' },
          { cmd: 'show lldp neighbors', what: 'Any LLDP device plugged into this one' },
          { cmd: 'show logging', what: 'The log buffer' },
          { cmd: 'show running-config', what: 'The configuration in use' },
        ],
      },
      {
        group: 'Change and save',
        items: [
          { cmd: 'configure terminal', what: 'Enter configuration mode (end to leave)', danger: true },
          { cmd: 'copy running-config startup-config', what: 'Save the configuration so it survives a restart', danger: true },
          { cmd: 'reload', what: 'Restart the device', danger: true },
        ],
      },
    ],
    docs: [
      { label: 'Cisco support and documentation', url: 'https://www.cisco.com/c/en/us/support/index.html' },
      { label: 'Cisco Community', url: 'https://community.cisco.com' },
    ],
  },
  {
    id: 'fortinet',
    name: 'Fortinet FortiGate',
    match: /fortinet|fortigate|fortiswitch|fortiap/i,
    kind: 'Firewall',
    defaultUser: 'admin',
    webPorts: [443, 80],
    login: ['Log in with an administrator account from System → Administrators.'],
    noPaging: 'config system console\nset output standard\nend',
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'get system status', what: 'Model, firmware, serial number and license' },
          { cmd: 'get system performance status', what: 'CPU, memory and sessions' },
          { cmd: 'get system interface physical', what: 'Physical ports and their state' },
          { cmd: 'get router info routing-table all', what: 'The routing table' },
          { cmd: 'diagnose sys top 5 20', what: 'Busiest processes (q to quit)' },
          { cmd: 'execute ping 8.8.8.8', what: 'Ping from the firewall' },
        ],
      },
      {
        group: 'Change',
        items: [
          { cmd: 'show full-configuration system interface', what: 'Interface configuration' },
          { cmd: 'execute reboot', what: 'Restart the firewall', danger: true },
        ],
      },
    ],
    docs: [
      { label: 'Fortinet Document Library', url: 'https://docs.fortinet.com' },
      { label: 'Fortinet Community', url: 'https://community.fortinet.com' },
    ],
  },
  {
    id: 'paloalto',
    name: 'Palo Alto Networks PAN-OS',
    match: /palo ?alto/i,
    kind: 'Firewall',
    defaultUser: 'admin',
    webPorts: [443],
    login: ['Log in with an administrator account. Operational mode shows >; type configure for configuration mode (#).'],
    noPaging: 'set cli pager off',
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'show system info', what: 'Model, PAN-OS version, serial and uptime' },
          { cmd: 'show interface all', what: 'Interfaces and their state' },
          { cmd: 'show routing route', what: 'The routing table' },
          { cmd: 'show session info', what: 'Session counts and limits' },
          { cmd: 'show counter global filter delta yes severity drop', what: 'Why packets are being dropped' },
        ],
      },
      { group: 'Change', items: [{ cmd: 'configure', what: 'Configuration mode (commit to apply)', danger: true }] },
    ],
    docs: [{ label: 'Palo Alto Networks TechDocs', url: 'https://docs.paloaltonetworks.com' }],
  },
  {
    id: 'juniper',
    name: 'Juniper Junos',
    match: /juniper/i,
    kind: 'Switch, router or firewall',
    webPorts: [443],
    login: ['Log in with a local or RADIUS account. If you land in a Unix shell (%), type cli.'],
    noPaging: 'set cli screen-length 0',
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'show version', what: 'Model and Junos version' },
          { cmd: 'show interfaces terse', what: 'Every interface with its address and state' },
          { cmd: 'show route', what: 'The routing table' },
          { cmd: 'show chassis hardware', what: 'Hardware inventory and serial numbers' },
          { cmd: 'show log messages | last 50', what: 'The last 50 log lines' },
          { cmd: 'show configuration | display set', what: 'The configuration as set commands' },
        ],
      },
      {
        group: 'Change',
        items: [
          { cmd: 'configure', what: 'Configuration mode', danger: true },
          { cmd: 'commit confirmed 5', what: 'Apply changes, rolling back in 5 minutes unless you commit again', danger: true },
        ],
      },
    ],
    docs: [{ label: 'Juniper TechLibrary', url: 'https://www.juniper.net/documentation/' }],
  },
  {
    id: 'aruba',
    name: 'HPE Aruba switches',
    match: /aruba|hewlett packard enterprise|procurve|hpe /i,
    kind: 'Switch or access point',
    legacyCrypto: true,
    webPorts: [443, 80],
    login: ['Log in as manager (ArubaOS-Switch) or admin (AOS-CX).'],
    noPaging: 'no page',
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'show system', what: 'Model, firmware and uptime' },
          { cmd: 'show interfaces brief', what: 'Ports and their state' },
          { cmd: 'show vlans', what: 'VLANs (AOS-CX: show vlan)' },
          { cmd: 'show lldp info remote-device', what: 'Devices plugged in (AOS-CX: show lldp neighbor-info)' },
          { cmd: 'show running-config', what: 'The configuration in use' },
        ],
      },
      { group: 'Save', items: [{ cmd: 'write memory', what: 'Save the configuration', danger: true }] },
    ],
    docs: [{ label: 'HPE Aruba Networking support', url: 'https://support.hpe.com' }],
  },
  {
    id: 'mikrotik',
    name: 'MikroTik RouterOS',
    match: /mikrotik|routerboard/i,
    kind: 'Router or switch',
    defaultUser: 'admin',
    webPorts: [80, 443],
    login: ['Log in as admin (newer devices print a unique default password on their label).', 'Commands start with a path such as /ip address; press Tab to complete.'],
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: '/system resource print', what: 'Model, RouterOS version, CPU, memory and uptime' },
          { cmd: '/interface print', what: 'Interfaces and their state' },
          { cmd: '/ip address print', what: 'IP addresses' },
          { cmd: '/ip route print', what: 'The routing table' },
          { cmd: '/ip dhcp-server lease print', what: 'Devices that got an address from the router' },
          { cmd: '/log print', what: 'The log' },
          { cmd: '/export compact', what: 'The whole configuration' },
        ],
      },
      { group: 'Change', items: [{ cmd: '/system reboot', what: 'Restart the router', danger: true }] },
    ],
    docs: [{ label: 'MikroTik documentation', url: 'https://help.mikrotik.com/docs/' }],
  },
  {
    id: 'netgate',
    name: 'pfSense / OPNsense',
    match: /netgate|pfsense|opnsense|deciso/i,
    kind: 'Firewall',
    defaultUser: 'admin',
    webPorts: [443, 80],
    login: ['Log in as admin (or root on OPNsense). You land in a numbered console menu; option 8 opens a shell.'],
    commands: [
      {
        group: 'Shell (menu 8)',
        items: [
          { cmd: 'ifconfig', what: 'Interfaces and addresses' },
          { cmd: 'netstat -rn', what: 'The routing table' },
          { cmd: 'pfctl -sr', what: 'Firewall rules as loaded' },
          { cmd: 'pfctl -ss | head -n 50', what: 'The first 50 open connections' },
          { cmd: 'top -aSH', what: 'Busiest processes (q to quit)' },
        ],
      },
    ],
    docs: [
      { label: 'pfSense documentation', url: 'https://docs.netgate.com/pfsense/en/latest/' },
      { label: 'OPNsense documentation', url: 'https://docs.opnsense.org' },
    ],
  },
  {
    id: 'tplink',
    name: 'TP-Link Omada / JetStream',
    match: /tp-?link|omada/i,
    kind: 'Switch, router or access point',
    defaultUser: 'admin',
    webPorts: [443, 80],
    login: ['Log in with the device (or Omada controller) administrator account, then type enable.'],
    commands: [
      {
        group: 'Look around (managed switches)',
        items: [
          { cmd: 'enable', what: 'Privileged mode' },
          { cmd: 'show system-info', what: 'Model, firmware and uptime' },
          { cmd: 'show interface status', what: 'Ports and their state' },
          { cmd: 'show vlan brief', what: 'VLANs' },
          { cmd: 'show running-config', what: 'The configuration in use' },
        ],
      },
      { group: 'Save', items: [{ cmd: 'copy running-config startup-config', what: 'Save the configuration', danger: true }] },
    ],
    docs: [{ label: 'TP-Link support', url: 'https://www.tp-link.com/support/' }],
  },
  {
    id: 'netgear',
    name: 'NETGEAR managed switches',
    match: /netgear/i,
    kind: 'Switch or router',
    defaultUser: 'admin',
    webPorts: [80, 443],
    login: ['Log in with the switch administrator account, then type enable.'],
    noPaging: 'terminal length 0',
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'enable', what: 'Privileged mode' },
          { cmd: 'show version', what: 'Model and firmware' },
          { cmd: 'show running-config', what: 'The configuration in use' },
          { cmd: 'show vlan brief', what: 'VLANs' },
        ],
      },
      { group: 'Save', items: [{ cmd: 'write memory', what: 'Save the configuration', danger: true }] },
    ],
    docs: [{ label: 'NETGEAR support', url: 'https://www.netgear.com/support/' }],
  },
  {
    id: 'sonicwall',
    name: 'SonicWall',
    match: /sonicwall/i,
    kind: 'Firewall',
    defaultUser: 'admin',
    webPorts: [443],
    login: ['Log in with the administrator account. Type configure for configuration mode.'],
    commands: [{ group: 'Look around', items: [{ cmd: 'show status', what: 'Model, firmware, serial number and uptime' }] }],
    docs: [{ label: 'SonicWall support', url: 'https://www.sonicwall.com/support/' }],
  },
  {
    id: 'watchguard',
    name: 'WatchGuard Firebox',
    match: /watchguard/i,
    kind: 'Firewall',
    defaultUser: 'admin',
    sshPort: 4118,
    webPorts: [8080],
    login: ['SSH runs on port 4118. Log in as admin (read-write) or status (read-only).'],
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'show sysinfo', what: 'Model, Fireware version and uptime' },
          { cmd: 'show interface', what: 'Interfaces' },
        ],
      },
    ],
    docs: [{ label: 'WatchGuard Help Center', url: 'https://www.watchguard.com/help/docs/help-center/en-US/' }],
  },
  {
    id: 'zyxel',
    name: 'Zyxel',
    match: /zyxel/i,
    kind: 'Switch, router or firewall',
    defaultUser: 'admin',
    webPorts: [443, 80],
    login: ['Log in with the administrator account.'],
    commands: [{ group: 'Look around', items: [{ cmd: 'show version', what: 'Model and firmware' }, { cmd: 'show running-config', what: 'The configuration in use' }] }],
    docs: [{ label: 'Zyxel support', url: 'https://www.zyxel.com/global/en/support' }],
  },
  {
    id: 'synology',
    name: 'Synology NAS',
    match: /synology/i,
    kind: 'NAS storage',
    webPorts: [5001, 5000],
    login: ['Turn on SSH in DSM → Control Panel → Terminal & SNMP. Log in with an administrator account; sudo -i for root.'],
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'cat /etc.defaults/VERSION', what: 'DSM version' },
          { cmd: 'df -h', what: 'Free space on each volume' },
          { cmd: 'cat /proc/mdstat', what: 'RAID status' },
          { cmd: 'top', what: 'Busiest processes (q to quit)' },
        ],
      },
    ],
    docs: [{ label: 'Synology Knowledge Center', url: 'https://kb.synology.com' }],
  },
  {
    id: 'qnap',
    name: 'QNAP NAS',
    match: /qnap/i,
    kind: 'NAS storage',
    defaultUser: 'admin',
    webPorts: [443, 8080],
    login: ['Turn on SSH in Control Panel → Network & File Services → Telnet / SSH. Log in with an administrator account.'],
    commands: [{ group: 'Look around', items: [{ cmd: 'df -h', what: 'Free space' }, { cmd: 'cat /proc/mdstat', what: 'RAID status' }, { cmd: 'top', what: 'Busiest processes (q to quit)' }] }],
    docs: [{ label: 'QNAP support', url: 'https://www.qnap.com/en/support' }],
  },
  {
    id: 'raspberrypi',
    name: 'Raspberry Pi',
    match: /raspberry/i,
    kind: 'Small Linux computer',
    defaultUser: 'pi',
    login: ['Log in with the user you created in Raspberry Pi Imager.'],
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'hostnamectl', what: 'Model, operating system and kernel' },
          { cmd: 'vcgencmd measure_temp', what: 'CPU temperature' },
          { cmd: 'df -h', what: 'Free space' },
          { cmd: 'free -h', what: 'Memory use' },
          { cmd: 'systemctl --failed', what: 'Services that failed to start' },
        ],
      },
      { group: 'Maintain', items: [{ cmd: 'sudo apt update && sudo apt full-upgrade', what: 'Install updates', danger: true }] },
    ],
    docs: [{ label: 'Raspberry Pi documentation', url: 'https://www.raspberrypi.com/documentation/' }],
  },
  {
    id: 'linux',
    name: 'Linux / Unix server',
    match: /^$/,
    kind: 'Server',
    login: ['Log in with your user account. sudo runs a command as administrator.'],
    commands: [
      {
        group: 'Look around',
        items: [
          { cmd: 'uname -a', what: 'Kernel and architecture' },
          { cmd: 'cat /etc/os-release', what: 'Which Linux this is' },
          { cmd: 'uptime', what: 'How long it has been running and the load' },
          { cmd: 'df -h', what: 'Free space' },
          { cmd: 'free -h', what: 'Memory use' },
          { cmd: 'ip -br address', what: 'Network interfaces and addresses' },
          { cmd: 'systemctl --failed', what: 'Services that failed' },
          { cmd: 'journalctl -p err -b --no-pager | tail -n 50', what: 'Recent errors since boot' },
        ],
      },
    ],
    docs: [],
  },
];

const BY_ID = new Map(DEVICE_PROFILES.map((p) => [p.id, p]));

export function deviceProfile(id: string | null | undefined): DeviceProfile | null {
  return (id && BY_ID.get(id)) || null;
}

/**
 * The profile for a scanned device: by maker (MAC vendor), model or name; a device that only shows SSH gets the
 * generic Linux profile. Null when nothing suggests a command line.
 */
export function matchDeviceProfile(d: { vendor?: string | null; name?: string | null; model?: string | null; ports?: number[] }): DeviceProfile | null {
  const text = [d.vendor, d.model, d.name].filter(Boolean).join(' ');
  if (text) for (const p of DEVICE_PROFILES) if (p.id !== 'linux' && p.match.test(text)) return p;
  return d.ports?.includes(22) ? BY_ID.get('linux')! : null;
}

/** A web search for a vendor's command reference (for gear without a built-in guide). */
export function commandSearchUrl(vendor: string, model?: string | null): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(`${vendor} ${model ?? ''} CLI command reference`.replace(/\s+/g, ' ').trim())}`;
}
