/*
 * The Lab: the Library's Advanced-mode corner. Power-user how-tos and official download pages (vendors and projects
 * only, never mirrors), each section with a dry remark. Steps may contain <kbd> and <code> only.
 */

export interface LabHowTo {
  t: string;
  steps: string[];
  go?: string;
  ask?: string;
}

export const LAB_HOWTOS: LabHowTo[] = [
  {
    t: 'Make a Windows 11 install USB',
    steps: ['Download the Media Creation Tool (below).', 'Plug in a USB stick of 8 GB or more (it will be erased).', 'Run the tool → "Create installation media" → USB flash drive.', 'Boot from it with the boot-menu key (often <kbd>F11</kbd>, <kbd>F12</kbd> or <kbd>Esc</kbd>).'],
  },
  {
    t: 'Dual-boot Linux next to Windows',
    steps: ['Back up first. Suspend BitLocker if it is on (Storage → Drives).', 'Shrink C: to make free space (Storage → Disks & partitions).', 'Boot the Linux USB and choose "Install alongside Windows".', 'Ask Fabrix for a plan that fits your exact disk layout.'],
    ask: 'Help me plan a Linux dual boot on this PC: look at my disks and partitions and tell me exactly how much to shrink, what to back up first and what to watch out for with BitLocker and Secure Boot.',
  },
  {
    t: 'Build an isolated malware lab',
    steps: ['Virtual lab → create REMnux and FLARE-VM machines with the network set to none or a private switch.', 'Take a checkpoint before every sample; revert afterwards.', 'Never share host folders or the clipboard with the lab.', 'Move samples in password-protected zips (the custom is the password "infected").'],
    go: 'lab',
  },
  {
    t: 'SSH into a switch, firewall or access point',
    steps: ['Network Center → Devices → Scan now.', 'Click the device → Connect. Confirm its key the first time.', 'The guide next to the console has the maker\'s common commands and documentation.', 'Get help from Fabrix: it can read the console and type commands you approve.'],
    go: 'network',
  },
  {
    t: 'Read a blue screen dump',
    steps: ['Install WinDbg from the Microsoft Store.', 'Open <code>C:\\Windows\\Minidump</code>, newest file first (needs administrator rights).', 'Run <code>!analyze -v</code> and look at MODULE_NAME and IMAGE_NAME: that is usually the driver to update or remove.', 'Or open Bug catcher → Blue screens and ask Fabrix.'],
    go: 'bugs',
  },
  {
    t: 'Find what is holding a file open',
    steps: ['Open Resource Monitor (<code>resmon</code>) → CPU tab.', 'Type part of the file name in "Associated Handles".', 'End the process shown, or close it properly from its own window.'],
  },
  {
    t: 'Repair Windows without reinstalling',
    steps: ['Open an administrator terminal.', 'Run <code>DISM /Online /Cleanup-Image /RestoreHealth</code> and wait for 100%.', 'Then <code>sfc /scannow</code>.', 'Restart. Bug catcher has both as one-click fixes.'],
    go: 'bugs',
  },
  {
    t: 'Verify a download',
    steps: ['Find the SHA-256 checksum on the publisher\'s page.', 'Terminal: <code>Get-FileHash .\\file.iso -Algorithm SHA256</code>.', 'The two must match exactly. If not, delete the file and download it again from the official page.'],
    ask: 'Walk me through verifying a downloaded ISO on Windows: computing its SHA-256 with Get-FileHash and comparing it with the publisher\'s checksum (and checking a GPG signature if one is offered).',
  },
];

export interface LabSection {
  sec: string;
  quip: string;
  items: Array<[title: string, url: string, note: string]>;
}

export const LAB_SECTIONS: LabSection[] = [
  {
    sec: 'Install media & ISOs',
    quip: 'Every great story starts with a USB stick and the words "how hard can it be?"',
    items: [
      ['Windows 11 download page', 'https://www.microsoft.com/software-download/windows11', 'ISO, Media Creation Tool and Installation Assistant. The only place to get Windows from.'],
      ['Windows 11 Enterprise, 90-day evaluation', 'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise', 'Perfect for virtual machines you plan to destroy.'],
      ['Windows Server 2025, 180-day evaluation', 'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2025', 'For when one computer at home is just not enough infrastructure.'],
      ['Windows Insider Preview ISOs', 'https://www.microsoft.com/software-download/windowsinsiderpreviewiso', 'Tomorrow\'s bugs, today. Insider sign-in required.'],
    ],
  },
  {
    sec: 'Bootable USB tools',
    quip: 'Because burning DVDs is a lost art, and nobody has a drive anyway.',
    items: [
      ['Rufus', 'https://rufus.ie/', 'Tiny, fast, and can relax Windows 11 setup checks on test machines.'],
      ['Ventoy', 'https://www.ventoy.net/en/download.html', 'Copy many ISOs onto one stick and pick at boot. Hoarders welcome.'],
      ['Raspberry Pi Imager', 'https://www.raspberrypi.com/software/', 'Flash SD cards for the drawer of tiny computers.'],
    ],
  },
  {
    sec: 'Linux',
    quip: 'Side effects may include telling everyone you use Linux.',
    items: [
      ['Ubuntu Desktop', 'https://ubuntu.com/download/desktop', 'The friendly default.'],
      ['Linux Mint', 'https://linuxmint.com/download.php', 'Feels like Windows 7 went to therapy.'],
      ['Fedora Workstation', 'https://fedoraproject.org/workstation/download', 'Fresh GNOME, fresh kernels.'],
      ['Debian', 'https://www.debian.org/distrib/', 'Stable like your grandparents\' furniture.'],
    ],
  },
  {
    sec: 'Security lab',
    quip: 'Only point these at things you own. Your neighbor\'s smart fridge has rights too.',
    items: [
      ['Kali Linux', 'https://www.kali.org/get-kali/', 'The penetration tester\'s Swiss Army knife.'],
      ['REMnux', 'https://docs.remnux.org/install-distro/get-virtual-appliance', 'Malware-analysis toolkit. Air-gap it. Seriously.'],
      ['FLARE-VM (Mandiant)', 'https://github.com/mandiant/flare-vm', 'Turns a Windows virtual machine into a reverse-engineering workstation.'],
      ['OPNsense', 'https://opnsense.org/download/', 'Build your own firewall in a virtual machine and feel like a network wizard.'],
    ],
  },
  {
    sec: 'Power tools',
    quip: 'Tools that make you say "wait, Windows can do that?"',
    items: [
      ['Sysinternals Suite', 'https://learn.microsoft.com/en-us/sysinternals/', 'Process Explorer, Autoruns, Process Monitor: the classics.'],
      ['PowerToys', 'https://learn.microsoft.com/en-us/windows/powertoys/', 'FancyZones, PowerRename, Color Picker and more.'],
      ['PowerShell 7', 'https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows', 'The modern PowerShell. Once installed, the FBRX Terminal uses it.'],
      ['WSL', 'https://learn.microsoft.com/en-us/windows/wsl/install', '<code>wsl --install</code> and you have Linux in a terminal tab.'],
      ['winget', 'https://learn.microsoft.com/en-us/windows/package-manager/winget/', 'Install apps like a Linux person: <code>winget install Git.Git</code>.'],
      ['Ollama', 'https://ollama.com/download', 'An engine for Fabrix\'s brain. Pull bigger models if your GPU is feeling brave.'],
    ],
  },
  {
    sec: 'Diagnostics & networking',
    quip: 'For when "have you tried turning it off and on again" has failed you.',
    items: [
      ['MemTest86+', 'https://www.memtest.org/', 'Boot it, wait, find out your RAM was the villain all along.'],
      ['CrystalDiskInfo', 'https://crystalmark.info/en/software/crystaldiskinfo/', 'Full S.M.A.R.T. data for every disk.'],
      ['HWiNFO', 'https://www.hwinfo.com/download/', 'Every sensor on your machine, in more detail than you wanted.'],
      ['Wireshark', 'https://www.wireshark.org/download.html', 'Watch packets go by. Mesmerizing. Mildly addictive.'],
      ['Nmap', 'https://nmap.org/download', 'The network scanner. Your own network only.'],
      ['PuTTY', 'https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html', 'The legendary SSH client (FBRX has device consoles built in too).'],
    ],
  },
];

/** The maker's driver and BIOS page for this computer (a search on their support site). */
export function supportPage(manufacturer: string, model: string): { label: string; url: string } | null {
  const m = manufacturer.toLowerCase();
  const q = encodeURIComponent(model.trim());
  if (!model.trim() || /to be filled|default string|system product/i.test(model)) return null;
  if (/micro-star|msi/.test(m)) return { label: `MSI support for ${model}`, url: `https://www.msi.com/search/${q}` };
  if (/dell/.test(m)) return { label: `Dell support for ${model}`, url: 'https://www.dell.com/support/home' };
  if (/hp|hewlett/.test(m)) return { label: `HP support for ${model}`, url: 'https://support.hp.com/drivers' };
  if (/lenovo/.test(m)) return { label: `Lenovo support for ${model}`, url: 'https://pcsupport.lenovo.com' };
  if (/asus/.test(m)) return { label: `ASUS support for ${model}`, url: `https://www.asus.com/support/` };
  if (/acer/.test(m)) return { label: `Acer support for ${model}`, url: 'https://www.acer.com/support' };
  if (/microsoft/.test(m)) return { label: `Surface drivers and firmware`, url: 'https://support.microsoft.com/surface' };
  if (/gigabyte/.test(m)) return { label: `GIGABYTE support for ${model}`, url: 'https://www.gigabyte.com/Support' };
  return { label: `Drivers and BIOS for ${model}`, url: `https://duckduckgo.com/?q=${encodeURIComponent(`${manufacturer} ${model} drivers BIOS support`)}` };
}
