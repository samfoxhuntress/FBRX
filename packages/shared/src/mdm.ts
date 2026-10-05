import { AUDIENCES, type Audience } from './editions';
import type { ProvisioningFile } from './protocol';

/**
 * Device managers (MDM). FBRX Command makes the files a device manager pushes so computers join on their own:
 *
 * - **macOS** (Jamf, Mosyle, Kandji, Intune, Apple School Manager–linked managers): a configuration profile that sets
 *   FBRX's managed preferences (domain `com.fbrx.os`). FBRX reads `/Library/Managed Preferences/com.fbrx.os.plist`
 *   at start and joins the organization.
 * - **Windows** (Intune and others): a PowerShell script that writes `%ProgramData%\FBRX OS\fbrx-provision.json` and
 *   installs FBRX for all users silently.
 */

export const MANAGED_PREFERENCES_DOMAIN = 'com.fbrx.os';

/** Managed preference keys (the profile) → a provisioning file, or null when the server or token is missing. */
export function provisioningFromPreferences(prefs: Record<string, unknown>): (ProvisioningFile & { audience?: Audience }) | null {
  const str = (...keys: string[]) => {
    for (const k of keys) {
      const v = prefs[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  const serverUrl = str('ServerURL', 'serverUrl');
  const enrollmentToken = str('EnrollmentToken', 'enrollmentToken');
  if (!serverUrl || !enrollmentToken) return null;
  const audience = str('Audience', 'audience');
  return {
    fbrxProvisioning: 1,
    serverUrl,
    enrollmentToken,
    ...(str('DeviceName', 'deviceName') ? { deviceName: str('DeviceName', 'deviceName') } : {}),
    ...(audience && (AUDIENCES as readonly string[]).includes(audience) ? { audience: audience as Audience } : {}),
  };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface MdmInput {
  organization: string;
  /** What these computers are for, shown in the profile's name ("Students"). */
  label: string;
  serverUrl: string;
  enrollmentToken: string;
  audience?: Audience | null;
  /** UUIDs for the profile and its payload (pass fresh ones). */
  uuids: [string, string];
}

/** A macOS configuration profile (.mobileconfig) that makes FBRX join the organization. */
export function macProfile(i: MdmInput): string {
  const settings: Array<[string, string]> = [
    ['ServerURL', i.serverUrl],
    ['EnrollmentToken', i.enrollmentToken],
    ...(i.audience ? ([['Audience', i.audience]] as Array<[string, string]>) : []),
  ];
  const [profileUuid, payloadUuid] = i.uuids;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.ManagedClient.preferences</string>
      <key>PayloadIdentifier</key>
      <string>${MANAGED_PREFERENCES_DOMAIN}.preferences.${payloadUuid}</string>
      <key>PayloadUUID</key>
      <string>${payloadUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadDisplayName</key>
      <string>FBRX OS: join ${xml(i.organization)}</string>
      <key>PayloadContent</key>
      <dict>
        <key>${MANAGED_PREFERENCES_DOMAIN}</key>
        <dict>
          <key>Forced</key>
          <array>
            <dict>
              <key>mcx_preference_settings</key>
              <dict>
${settings.map(([k, v]) => `                <key>${k}</key>\n                <string>${xml(v)}</string>`).join('\n')}
              </dict>
            </dict>
          </array>
        </dict>
      </dict>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>FBRX OS · ${xml(i.organization)} (${xml(i.label)})</string>
  <key>PayloadDescription</key>
  <string>Connects FBRX OS on this Mac to ${xml(i.organization)}'s FBRX Command.</string>
  <key>PayloadIdentifier</key>
  <string>${MANAGED_PREFERENCES_DOMAIN}.profile.${profileUuid}</string>
  <key>PayloadOrganization</key>
  <string>${xml(i.organization)}</string>
  <key>PayloadScope</key>
  <string>System</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

/**
 * A PowerShell script for Intune (or any Windows device manager): writes the provisioning file and installs FBRX
 * silently for all users from an FBRX-OS-Setup-*.exe packaged next to it (or downloaded from `installerUrl`).
 */
export function windowsScript(i: Omit<MdmInput, 'uuids'> & { installerUrl?: string | null }): string {
  const prov: ProvisioningFile & { audience?: Audience } = { fbrxProvisioning: 1, serverUrl: i.serverUrl, enrollmentToken: i.enrollmentToken, ...(i.audience ? { audience: i.audience } : {}) };
  const ps = (s: string) => s.replace(/'/g, "''");
  return `# FBRX OS for ${i.organization} (${i.label}): join FBRX Command and install for all users.
# Intune: package this script with FBRX-OS-Setup-<version>.exe as a Win32 app (IntuneWinAppUtil), install command
#   powershell.exe -ExecutionPolicy Bypass -NoProfile -File Install-FBRX.ps1
# detection rule: file "%ProgramFiles%\\FBRX OS\\FBRX OS.exe" exists. Runs as SYSTEM.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'FBRX OS'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$provisioning = @'
${JSON.stringify(prov, null, 2)}
'@
Set-Content -Path (Join-Path $dir 'fbrx-provision.json') -Value $provisioning -Encoding UTF8

$setup = Get-ChildItem -Path $PSScriptRoot -Filter 'FBRX-OS-Setup-*.exe' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
$installerUrl = '${ps(i.installerUrl ?? '')}'
if (-not $setup -and $installerUrl) {
  $target = Join-Path $env:TEMP 'FBRX-OS-Setup.exe'
  Invoke-WebRequest -Uri $installerUrl -OutFile $target -UseBasicParsing
  $setup = Get-Item $target
}
if ($setup) {
  $p = Start-Process -FilePath $setup.FullName -ArgumentList '/S', '/allusers' -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3) { exit $p.ExitCode }
}
exit 0
`;
}
