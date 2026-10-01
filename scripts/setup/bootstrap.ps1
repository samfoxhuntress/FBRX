# FBRX OS installer bootstrap for Windows (started by "Install FBRX OS.cmd").
# Finds Node.js 22.15+ or downloads a private, checksum-verified copy into .fbrx-setup\node, then runs the wizard.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

function Test-NodeVersion([string]$exe) {
  try {
    $v = (& $exe --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $v) { return $false }
    $parts = $v.TrimStart('v').Split('.')
    $major = [int]$parts[0]; $minor = [int]$parts[1]
    return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 15)
  } catch { return $false }
}

$node = $null
$privateNode = Join-Path $root '.fbrx-setup\node\node.exe'
if (-not $env:FBRX_FORCE_PORTABLE_NODE) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found -and (Test-NodeVersion $found.Source)) { $node = $found.Source }
}
if (-not $node -and (Test-Path $privateNode) -and (Test-NodeVersion $privateNode)) { $node = $privateNode }

if (-not $node) {
  try {
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $platform = if ($arch -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
    $base = 'https://nodejs.org/dist/latest-v22.x'
    Write-Host 'Downloading Node.js for the installer (about 35 MB, used only by FBRX OS setup)...'
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $line = ($sums -split "`n") | Where-Object { $_ -match " node-v[\d.]+-$platform\.zip\s*$" } | Select-Object -First 1
    if (-not $line) { throw "No Node.js download found for $platform" }
    $fields = $line.Trim() -split '\s+'
    $sha = $fields[0]; $file = $fields[1]
    $setupDir = Join-Path $root '.fbrx-setup'
    New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
    $zip = Join-Path $setupDir $file
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $zip
    if ((Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower() -ne $sha.ToLower()) {
      Remove-Item -Force $zip
      throw 'The Node.js download was corrupted'
    }
    $unpack = Join-Path $setupDir 'node-unpack'
    $target = Split-Path $privateNode
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $unpack, $target
    New-Item -ItemType Directory -Force -Path $unpack | Out-Null
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) { & $tar.Source -xf $zip -C $unpack; if ($LASTEXITCODE -ne 0) { throw 'Could not unpack Node.js' } }
    else { Expand-Archive -Path $zip -DestinationPath $unpack -Force }
    Move-Item -Path (Get-ChildItem -Directory $unpack | Select-Object -First 1).FullName -Destination $target
    Remove-Item -Recurse -Force $unpack, $zip
    $node = $privateNode
  } catch {
    Write-Host ''
    Write-Host "Setup could not start: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Check your internet connection and double-click the installer again.'
    exit 1
  }
}

$ErrorActionPreference = 'Continue'
& $node (Join-Path $root 'scripts\setup\wizard.mjs') @args
exit $LASTEXITCODE
