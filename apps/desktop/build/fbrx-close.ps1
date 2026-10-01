# Closes FBRX OS before the Windows installer or uninstaller replaces its files.
#
# Every process started from the installation folder is found: the app and its helpers, the local AI runtime and
# the bridges other AI apps (Claude Desktop, Cursor, ...) start with the FBRX executable. The app is first asked to
# quit properly with "FBRX OS.exe --fbrx-quit", which stops the AI runtime and closes the database even when the
# window is hidden in the tray. Whatever is still running after the grace period is ended.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File fbrx-close.ps1 -Dir "<installation folder>"
#
# Exit codes: 0 nothing was running, 1 closed, 2 still running (for example started as administrator), 3 error.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$GraceSeconds = 20
)
$ErrorActionPreference = 'Stop'
try {
  $root = [IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'

  function Get-FbrxProcess {
    @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
      })
  }
  # Bridges for other AI apps do not answer the quit request; those apps start them again when needed.
  function Get-FbrxApp { @(Get-FbrxProcess | Where-Object { $_.CommandLine -notmatch 'fbrx-mcp\.mjs' }) }

  if (@(Get-FbrxProcess).Count -eq 0) { exit 0 }

  $exe = Join-Path $root 'FBRX OS.exe'
  if ((Test-Path -LiteralPath $exe) -and @(Get-FbrxApp).Count -gt 0) {
    Start-Process -FilePath $exe -ArgumentList '--fbrx-quit' -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds($GraceSeconds)
    do {
      Start-Sleep -Milliseconds 500
    } while (@(Get-FbrxApp).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
  }

  foreach ($p in Get-FbrxProcess) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 20 -and @(Get-FbrxProcess).Count -gt 0; $i++) { Start-Sleep -Milliseconds 250 }
  if (@(Get-FbrxProcess).Count -gt 0) { exit 2 }
  exit 1
} catch {
  exit 3
}
