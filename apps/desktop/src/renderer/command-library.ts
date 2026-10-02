/**
 * Ready-made Windows commands for the Terminal's reference panel and the Toolbox's command library. PowerShell
 * unless marked cmd; `admin` commands need an administrator terminal (the FBRX terminal runs as you).
 */
export interface LibraryCommand {
  title: string;
  cmd: string;
  what: string;
  admin?: boolean;
  /** Changes something: the Terminal asks before running it. */
  changes?: boolean;
}

export const COMMAND_GROUPS: Array<{ id: string; name: string; items: LibraryCommand[] }> = [
  {
    id: 'network',
    name: 'Network',
    items: [
      { title: 'IP addresses and DNS', cmd: 'Get-NetIPConfiguration | Format-List InterfaceAlias, IPv4Address, IPv4DefaultGateway, DNSServer', what: 'Every adapter with its address, router and DNS servers' },
      { title: 'Full IP configuration', cmd: 'ipconfig /all', what: 'The classic: MAC addresses, DHCP lease times and more' },
      { title: 'Test the internet', cmd: 'Test-NetConnection 1.1.1.1 -InformationLevel Detailed', what: 'Can this PC reach the internet, and through which adapter' },
      { title: 'Is a port open?', cmd: 'Test-NetConnection example.com -Port 443', what: 'Checks one TCP port on another computer' },
      { title: 'Trace the route', cmd: 'tracert -d 1.1.1.1', what: 'Every router between you and a server' },
      { title: 'Flush the DNS cache', cmd: 'Clear-DnsClientCache', what: 'Forget cached names after a website or DNS change', changes: true },
      { title: 'Look up a name', cmd: 'Resolve-DnsName example.com', what: 'What address a name points to, and which DNS server answered' },
      { title: 'Who is listening', cmd: 'Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Select-Object LocalAddress, LocalPort, @{n="Process";e={(Get-Process -Id $_.OwningProcess).ProcessName}}', what: 'Open ports on this PC and the program behind each' },
      { title: 'Active connections', cmd: 'Get-NetTCPConnection -State Established | Select-Object RemoteAddress, RemotePort, @{n="Process";e={(Get-Process -Id $_.OwningProcess).ProcessName}}', what: 'Which programs are talking to which servers right now' },
      { title: 'Devices on the network (ARP)', cmd: 'Get-NetNeighbor -AddressFamily IPv4 | Where-Object State -ne Unreachable', what: 'Addresses and MACs this PC has seen recently' },
      { title: 'Saved Wi-Fi networks', cmd: 'netsh wlan show profiles', what: 'Every Wi-Fi network this PC remembers' },
      { title: 'Wi-Fi password', cmd: 'netsh wlan show profile name="NETWORK" key=clear', what: 'Shows the saved password (Key Content); replace NETWORK' },
      { title: 'Wi-Fi report', cmd: 'netsh wlan show wlanreport', what: 'HTML report of disconnects over the last 3 days', admin: true },
      { title: 'Reset the network stack', cmd: 'netsh winsock reset; netsh int ip reset', what: 'Fixes broken networking after malware or VPN software; restart afterwards', admin: true, changes: true },
    ],
  },
  {
    id: 'system',
    name: 'System',
    items: [
      { title: 'System summary', cmd: 'Get-ComputerInfo | Select-Object CsName, OsName, OsVersion, OsBuildNumber, CsProcessors, CsTotalPhysicalMemory, BiosSMBIOSBIOSVersion', what: 'Windows edition and build, processor, memory and BIOS' },
      { title: 'Uptime', cmd: '(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime', what: 'How long since the last restart' },
      { title: 'Serial number and model', cmd: 'Get-CimInstance Win32_BIOS | Select-Object Manufacturer, SerialNumber, SMBIOSBIOSVersion', what: 'Handy for warranty and support calls' },
      { title: 'Installed programs', cmd: 'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object DisplayName | Sort-Object DisplayName | Select-Object DisplayName, DisplayVersion, Publisher', what: 'Everything in Apps & features' },
      { title: 'Recent errors', cmd: 'Get-WinEvent -FilterHashtable @{LogName="System"; Level=2; StartTime=(Get-Date).AddDays(-2)} -MaxEvents 30 | Format-Table TimeCreated, ProviderName, Id, Message -Wrap', what: 'System errors from the last two days' },
      { title: 'Unexpected shutdowns', cmd: 'Get-WinEvent -FilterHashtable @{LogName="System"; Id=41,6008} -MaxEvents 10 | Format-Table TimeCreated, Id, Message -Wrap', what: 'Crashes and power losses' },
      { title: 'Drivers with problems', cmd: 'Get-PnpDevice -PresentOnly | Where-Object Status -ne OK', what: 'Devices Windows is unhappy with' },
      { title: 'Group Policy report', cmd: 'gpresult /h "$env:USERPROFILE\\Desktop\\gpreport.html"; Start-Process "$env:USERPROFILE\\Desktop\\gpreport.html"', what: 'Which policies apply to you and this PC' },
      { title: 'License status', cmd: 'cscript //nologo $env:windir\\system32\\slmgr.vbs /dli', what: 'Windows activation details' },
    ],
  },
  {
    id: 'disk',
    name: 'Disks & files',
    items: [
      { title: 'Free space', cmd: 'Get-Volume | Where-Object DriveLetter | Sort-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, @{n="Free GB";e={[math]::Round($_.SizeRemaining/1GB,1)}}, @{n="Size GB";e={[math]::Round($_.Size/1GB,1)}}', what: 'Every drive and its free space' },
      { title: 'Disk health', cmd: 'Get-PhysicalDisk | Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus, @{n="Size GB";e={[math]::Round($_.Size/1GB)}}', what: 'Whether each disk reports itself healthy' },
      { title: 'Wear and temperature', cmd: 'Get-PhysicalDisk | Get-StorageReliabilityCounter | Select-Object DeviceId, Wear, Temperature, ReadErrorsTotal, WriteErrorsTotal', what: 'SSD wear, temperature and error counters', admin: true },
      { title: 'Biggest folders here', cmd: 'Get-ChildItem -Directory | ForEach-Object { [pscustomobject]@{ Folder = $_.Name; GB = [math]::Round(((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)/1GB, 2) } } | Sort-Object GB -Descending', what: 'Which folders in the current folder take the most space' },
      { title: 'Biggest files here', cmd: 'Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 20 FullName, @{n="MB";e={[math]::Round($_.Length/1MB)}}', what: 'The 20 largest files under the current folder' },
      { title: 'File checksum', cmd: 'Get-FileHash ".\\file.iso" -Algorithm SHA256', what: 'Check a download against the publisher\'s checksum' },
      { title: 'Find files by name', cmd: 'Get-ChildItem -Recurse -Filter "*.pdf" -ErrorAction SilentlyContinue | Select-Object FullName, LastWriteTime', what: 'Every PDF under the current folder (change the pattern)' },
      { title: 'Copy a folder (robust)', cmd: 'robocopy "C:\\Source" "D:\\Backup\\Source" /E /R:1 /W:1 /MT:8', what: 'Copies everything, resumes, retries; ideal for backups', changes: true },
      { title: 'Check the disk for errors', cmd: 'chkdsk C: /scan', what: 'Online scan for file system problems', admin: true },
    ],
  },
  {
    id: 'processes',
    name: 'Processes & services',
    items: [
      { title: 'Busiest programs (CPU)', cmd: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, @{n="MB";e={[math]::Round($_.WorkingSet64/1MB)}}', what: 'What has used the most processor time' },
      { title: 'Busiest programs (memory)', cmd: 'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, Id, @{n="MB";e={[math]::Round($_.WorkingSet64/1MB)}}', what: 'What is using the most memory' },
      { title: 'Stopped automatic services', cmd: 'Get-Service | Where-Object { $_.StartType -eq "Automatic" -and $_.Status -ne "Running" }', what: 'Services that should be running but are not' },
      { title: 'Restart a service', cmd: 'Restart-Service -Name Spooler', what: 'Restarts one service (here the print spooler)', admin: true, changes: true },
      { title: 'Startup programs', cmd: 'Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location', what: 'What starts when you sign in' },
      { title: 'Scheduled tasks', cmd: 'Get-ScheduledTask | Where-Object { $_.State -ne "Disabled" -and $_.TaskPath -notlike "\\Microsoft*" } | Select-Object TaskName, TaskPath, State', what: 'Non-Microsoft scheduled tasks (a favorite hiding place)' },
      { title: 'End a frozen program', cmd: 'Stop-Process -Name notepad -Force', what: 'Closes every copy of a program (change the name)', changes: true },
    ],
  },
  {
    id: 'repair',
    name: 'Repair & updates',
    items: [
      { title: 'Repair system files', cmd: 'sfc /scannow', what: 'Finds and fixes damaged Windows files', admin: true, changes: true },
      { title: 'Repair the Windows image', cmd: 'DISM /Online /Cleanup-Image /RestoreHealth', what: 'Fixes what sfc cannot (downloads clean files)', admin: true, changes: true },
      { title: 'Installed updates', cmd: 'Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 20 HotFixID, Description, InstalledOn', what: 'The most recent Windows updates' },
      { title: 'App updates (winget)', cmd: 'winget upgrade', what: 'Apps with a newer version available' },
      { title: 'Update every app', cmd: 'winget upgrade --all --silent', what: 'Installs all available app updates', changes: true },
      { title: 'Restore point now', cmd: 'Checkpoint-Computer -Description "Before changes" -RestorePointType MODIFY_SETTINGS', what: 'A safety net before you tinker', admin: true, changes: true },
      { title: 'Sync the clock', cmd: 'w32tm /resync', what: 'Fixes certificate errors caused by a wrong clock', admin: true, changes: true },
    ],
  },
  {
    id: 'security',
    name: 'Security',
    items: [
      { title: 'Defender status', cmd: 'Get-MpComputerStatus | Select-Object AMServiceEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, QuickScanAge, FullScanAge', what: 'Is antivirus on and up to date' },
      { title: 'Quick scan', cmd: 'Start-MpScan -ScanType QuickScan', what: 'A Defender quick scan', changes: true },
      { title: 'Threat history', cmd: 'Get-MpThreatDetection | Select-Object InitialDetectionTime, ThreatID, ActionSuccess, Resources', what: 'What Defender has found' },
      { title: 'Firewall profiles', cmd: 'Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction', what: 'Is the firewall on for each network type' },
      { title: 'Local administrators', cmd: 'Get-LocalGroupMember -Group Administrators', what: 'Who has full control of this PC' },
      { title: 'BitLocker status', cmd: 'manage-bde -status', what: 'Which drives are encrypted', admin: true },
      { title: 'Recent sign-ins', cmd: 'Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4624} -MaxEvents 20 | Select-Object TimeCreated, @{n="User";e={$_.Properties[5].Value}}, @{n="Type";e={$_.Properties[8].Value}}', what: 'Who signed in and how', admin: true },
    ],
  },
  {
    id: 'power',
    name: 'Power & battery',
    items: [
      { title: 'Battery health report', cmd: 'powercfg /batteryreport /output "$env:USERPROFILE\\Desktop\\battery.html"; Start-Process "$env:USERPROFILE\\Desktop\\battery.html"', what: 'Design versus actual capacity, and usage history' },
      { title: 'Energy problems', cmd: 'powercfg /energy /output "$env:USERPROFILE\\Desktop\\energy.html"', what: '60-second trace of what wastes power', admin: true },
      { title: 'What woke the PC', cmd: 'powercfg /lastwake', what: 'The device or task behind the last wake-up' },
      { title: 'What keeps it awake', cmd: 'powercfg /requests', what: 'Programs preventing sleep right now', admin: true },
      { title: 'Power plans', cmd: 'powercfg /list', what: 'Available power plans; the active one has a star' },
    ],
  },
  {
    id: 'printing',
    name: 'Printing',
    items: [
      { title: 'Printers', cmd: 'Get-Printer | Select-Object Name, DriverName, PortName, PrinterStatus', what: 'Every printer and its state' },
      { title: 'Print queue', cmd: 'Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name }', what: 'Documents waiting to print' },
      { title: 'Clear a stuck queue', cmd: 'Stop-Service Spooler -Force; Remove-Item "$env:windir\\System32\\spool\\PRINTERS\\*" -Force; Start-Service Spooler', what: 'Deletes stuck print jobs', admin: true, changes: true },
    ],
  },
];

export const ALL_COMMANDS = COMMAND_GROUPS.flatMap((g) => g.items.map((c) => ({ ...c, group: g.name })));
