@echo off
rem FBRX Command installer for Windows. Double-click this file in the unzipped FBRX folder. FBRX Command runs your
rem company's, school's or family's FBRX computers from your browser (options: see scripts\setup\command.mjs).
rem It uses your Node.js if it is new enough; otherwise it downloads a private copy into .fbrx-setup\ (nothing is
rem installed system-wide), then starts the setup in scripts\setup\command.mjs.
rem Opened from inside the downloaded zip, Windows unpacks only this file: it then offers to unzip the FBRX folder
rem first, using the PowerShell code at the end of this file, and continues with the unzipped copy.
rem "Install FBRX OS.cmd" is this same file with the three settings below changed.
setlocal
cd /d "%~dp0"
set "FBRX_PRODUCT=FBRX Command"
set "FBRX_LAUNCHER=Install FBRX Command.cmd"
set "FBRX_SETUP_SCRIPT=scripts\setup\command.mjs"
title %FBRX_PRODUCT% setup
set "FBRX_SKIP_PAUSE=%FBRX_NO_PAUSE%"
if not exist "%~dp0scripts\setup\bootstrap.ps1" goto unzip
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup\bootstrap.ps1" %*
set "FBRX_STATUS=%ERRORLEVEL%"
goto done

:unzip
set "FBRX_SELF=%~f0"
set "FBRX_DEST_FILE=%TEMP%\fbrx-unzip-%RANDOM%%RANDOM%.txt"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Content -LiteralPath $env:FBRX_SELF -Raw; Invoke-Expression ($s -split ('#FBRX' + '-UNZIP#'), 2)[1]"
set "FBRX_STATUS=%ERRORLEVEL%"
if not "%FBRX_STATUS%"=="0" goto done
set "FBRX_DEST="
set /p FBRX_DEST=<"%FBRX_DEST_FILE%"
del "%FBRX_DEST_FILE%" >nul 2>&1
if not exist "%FBRX_DEST%\%FBRX_LAUNCHER%" (
  echo Open the folder FBRX was unzipped to and double-click "%FBRX_LAUNCHER%" there.
  set "FBRX_STATUS=1"
  goto done
)
set "FBRX_NO_PAUSE=1"
call "%FBRX_DEST%\%FBRX_LAUNCHER%" %*
set "FBRX_STATUS=%ERRORLEVEL%"

:done
if not defined FBRX_SKIP_PAUSE (
  echo.
  pause
)
exit /b %FBRX_STATUS%
#FBRX-UNZIP#
# Runs when this file was opened from inside the downloaded zip: Windows unpacked only this one file into a temporary
# folder. Find the zip, unzip the FBRX folder to a permanent place and tell the batch part above where it is.
#   FBRX_UNZIP_TO   folder to unzip to (default: %USERPROFILE%\FBRX)
#   FBRX_UNZIP_YES  unzip without asking (used by the installer tests)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Show-Steps {
  Write-Host ''
  Write-Host 'To install:'
  Write-Host '  1. Close this window.'
  Write-Host '  2. In File Explorer, right-click the downloaded FBRX zip file and choose "Extract All...".'
  Write-Host "  3. Choose a permanent folder, for example $env:USERPROFILE\FBRX, and click Extract."
  Write-Host "  4. In the extracted folder, double-click `"$env:FBRX_LAUNCHER`"."
}
Write-Host ''
Write-Host "$env:FBRX_PRODUCT setup was opened from inside the downloaded zip file." -ForegroundColor Yellow
Write-Host 'Windows unpacked only this one file, so setup cannot see the rest of the FBRX folder yet.'

$places = @()
try { $places += (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch {}
$places += @("$env:USERPROFILE\Downloads", "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Documents")
if ($env:OneDrive) { $places += @("$env:OneDrive\Downloads", "$env:OneDrive\Desktop", "$env:OneDrive\Documents") }
$places = @($places | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)

# Explorer opens files from a zip in %TEMP%\<id>_<zip name>.zip.<n>\ (or Temp1_<zip name>.zip\ on older Windows).
$zipName = $null
foreach ($part in (Split-Path -Parent $env:FBRX_SELF).Split('\')) {
  if ($part -match '^(?:Temp\d+_|[0-9a-fA-F-]{36}_)(.+\.zip)(?:\.[0-9a-zA-Z]+)?$') { $zipName = $Matches[1] }
}
$zip = $null
if ($zipName) {
  foreach ($p in $places) {
    if (Test-Path -LiteralPath (Join-Path $p $zipName)) { $zip = Join-Path $p $zipName; break }
  }
} else {
  # Other zip tools (7-Zip, WinRAR) use temporary folders without the zip's name: offer the newest FBRX zip.
  $newest = @($places | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.zip' -File -ErrorAction SilentlyContinue } | Where-Object { $_.Name -match 'FBRX' } | Sort-Object LastWriteTime -Descending)[0]
  if ($newest) { $zip = $newest.FullName; $zipName = $newest.Name }
}
if (-not $zip) {
  if ($zipName) { Write-Host "Could not find $zipName in your Downloads, Desktop or Documents folder." }
  Show-Steps
  exit 1
}

$dest = if ($env:FBRX_UNZIP_TO) { $env:FBRX_UNZIP_TO } else { Join-Path $env:USERPROFILE 'FBRX' }
Write-Host ''
Write-Host "Found $zip"
if (-not $env:FBRX_UNZIP_YES) {
  $answer = Read-Host "Unzip FBRX to $dest and continue? Press Enter for yes, type N to stop, or type another folder"
  if ($answer -match '^\s*(n|no)\s*$') { Show-Steps; exit 1 }
  if ($answer -and $answer -notmatch '^\s*(y|yes)\s*$') { $dest = $answer.Trim().Trim('"') }
}
$dest = [IO.Path]::GetFullPath($dest)
if ($dest.Length -gt 3) { $dest = $dest.TrimEnd('\') }
if ($dest -match '(?i)(OneDrive|Dropbox|Google Drive|iCloudDrive)') {
  Write-Host 'Note: that folder is synced to the cloud, which makes the build slow. A folder such as C:\FBRX is better.' -ForegroundColor Yellow
}
$stage = Join-Path $env:TEMP ('fbrx-unzip-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
  Write-Host 'Unzipping...'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $stage)
  $root = @(Get-ChildItem -LiteralPath $stage -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'scripts\setup\bootstrap.ps1') })[0]
  if (-not $root -and (Test-Path -LiteralPath (Join-Path $stage 'scripts\setup\bootstrap.ps1'))) { $root = Get-Item -LiteralPath $stage }
  if (-not $root) { throw "$zipName does not contain the FBRX folder" }
  # Unzipped over an earlier copy of the FBRX folder, like "Extract All": its license keys, setup downloads and shared
  # installers are kept.
  & robocopy.exe $root.FullName $dest /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copying into $dest failed (robocopy exit code $LASTEXITCODE)" }
} catch {
  Write-Host ''
  Write-Host "Unzipping failed: $($_.Exception.Message)" -ForegroundColor Red
  Show-Steps
  exit 1
} finally {
  Remove-Item -Recurse -Force -LiteralPath $stage -ErrorAction SilentlyContinue
}
Write-Host "FBRX is unzipped in $dest" -ForegroundColor Green
Write-Host 'Next time, start setup from that folder.'
Write-Host ''
# The batch part reads the folder back in the console's code page.
[IO.File]::WriteAllBytes($env:FBRX_DEST_FILE, [Console]::OutputEncoding.GetBytes($dest))
exit 0
