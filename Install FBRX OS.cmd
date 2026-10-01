@echo off
rem FBRX OS installer for Windows. Double-click this file in File Explorer.
rem It uses your Node.js if it is new enough; otherwise it downloads a private copy into .fbrx-setup\ (nothing is
rem installed system-wide), then starts the setup wizard in scripts\setup\wizard.mjs.
setlocal
cd /d "%~dp0"
title FBRX OS setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup\bootstrap.ps1" %*
set "FBRX_STATUS=%ERRORLEVEL%"
if not defined FBRX_NO_PAUSE (
  echo.
  pause
)
exit /b %FBRX_STATUS%
