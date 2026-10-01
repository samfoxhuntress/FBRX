; FBRX OS additions to the Windows installer and uninstaller (electron-builder `nsis.include`).
;
; Run over an existing installation, Setup opens on a maintenance page instead of asking where to install:
;   Upgrade    this package is newer: install it, keeping data, settings, license and paired devices
;   Repair     reinstall the program files from this package and clear cached files; data is kept
;   Uninstall  remove FBRX OS, optionally together with its data
; A package older than the installed version offers a downgrade instead, with a warning.
;
; A running FBRX OS is closed automatically (fbrx-close.ps1): it is asked to quit properly, then anything still
; running from the installation folder is ended.
;
; Command line, for IT tools and the setup wizard:
;   /S                      install, upgrade or reinstall without questions (a downgrade is refused, exit code 3)
;   /S /ALLOWDOWNGRADE      also allow installing an older version
;   /S /REPAIR              also clear cached files
;   /S /UNINSTALL           uninstall and keep the data; add --delete-app-data to delete it as well
;
; A license key is activated for the user when Setup carries one (share packages made by the setup wizard embed it
; at build time through the FBRX_SHARE_LICENSE environment variable) or finds fbrx-license.key next to Setup.exe.

!include LogicLib.nsh
!include FileFunc.nsh
!include WordFunc.nsh

; Result of the last attempt to close the app: 0 nothing was running, 1 closed, 2 still running.
Var fbrxClosed

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var fbrxInstalled   ; version found in the registry, "" when FBRX OS is not installed
  Var fbrxCompare     ; this package against the installed version: 0 same, 1 newer, 2 older
  Var fbrxRemoveData  ; 1 = also delete the data folder when uninstalling
  Var fbrxRadioMain
  Var fbrxRadioRepair
  Var fbrxRadioRemove
  Var fbrxCheckData

  !if /FileExists "$%FBRX_SHARE_LICENSE%"
    !define /file FBRX_EMBEDDED_LICENSE "$%FBRX_SHARE_LICENSE%"
  !endif
!endif

; ------------------------------------------------------------------------------------------- closing the app

!macro FBRX_CLOSE_APP
  InitPluginsDir
  File "/oname=$PLUGINSDIR\fbrx-close.ps1" "${BUILD_RESOURCES_DIR}/fbrx-close.ps1"
  DetailPrint "Closing ${PRODUCT_NAME}..."
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\fbrx-close.ps1" -Dir "$INSTDIR"`
  Pop $fbrxClosed
  ${If} $fbrxClosed != 0
  ${AndIf} $fbrxClosed != 1
  ${AndIf} $fbrxClosed != 2
    ; PowerShell is unavailable or blocked by policy: end the app by name, for this user only.
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $fbrxClosed
    Sleep 1500
    StrCpy $fbrxClosed 1
  ${EndIf}
!macroend

; Replaces electron-builder's check (installer and uninstaller): close without asking, retry only if that fails.
!macro customCheckAppRunning
  ${Do}
    !insertmacro FBRX_CLOSE_APP
    ${If} $fbrxClosed != 2
      ${Break}
    ${EndIf}
    ${IfNot} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} is still running and could not be closed automatically (it may have been started as administrator).$\r$\n$\r$\nQuit it from its icon in the taskbar notification area, then click Retry." /SD IDCANCEL IDRETRY`
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${Loop}
!macroend

; ------------------------------------------------------------------------------------------- installer start

!macro customInit
  StrCpy $fbrxRemoveData 0
  StrCpy $fbrxCompare 1
  ReadRegStr $fbrxInstalled SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${If} $fbrxInstalled != ""
    ${VersionCompare} "${VERSION}" "$fbrxInstalled" $fbrxCompare
  ${EndIf}

  ${If} ${Silent}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/UNINSTALL" $R1
    ${IfNot} ${Errors}
      ${If} $fbrxInstalled != ""
        ClearErrors
        ${GetOptions} $R0 "--delete-app-data" $R1
        ${IfNot} ${Errors}
          StrCpy $fbrxRemoveData 1
        ${EndIf}
        Call fbrxUninstall
      ${EndIf}
      SetErrorLevel 0
      Quit
    ${EndIf}

    ${If} $fbrxInstalled != ""
    ${AndIf} $fbrxCompare == 2
      ClearErrors
      ${GetOptions} $R0 "/ALLOWDOWNGRADE" $R1
      ${If} ${Errors}
        ; Exit code 3: a newer version is installed.
        SetErrorLevel 3
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Keep the existing installation's mode (just me / all users) instead of asking again.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${If} $fbrxInstalled != ""
      ${If} $hasPerMachineInstallation == "1"
        StrCpy $isForceMachineInstall "1"
      ${Else}
        StrCpy $isForceCurrentInstall "1"
      ${EndIf}
    ${EndIf}
  !endif
!macroend

; ------------------------------------------------------------------------------------------- maintenance page

!macro customWelcomePage
  Page custom fbrxMaintenancePage fbrxMaintenanceLeave
!macroend

; Inserted after electron-builder declared its pages and variables, so the functions below can use them.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; Pages between the maintenance page and the progress page, all skipped when maintaining an installation.
    !define FBRX_TO_PROGRESS 1
    !ifmacrodef licensePage
      !define /redef /math FBRX_TO_PROGRESS ${FBRX_TO_PROGRESS} + 1
    !endif
    !ifndef INSTALL_MODE_PER_ALL_USERS
      !define /redef /math FBRX_TO_PROGRESS ${FBRX_TO_PROGRESS} + 1
    !endif
    !ifdef allowToChangeInstallationDirectory
      !define /redef /math FBRX_TO_PROGRESS ${FBRX_TO_PROGRESS} + 1
    !endif

    Function fbrxMaintenancePage
      ; A fresh install, an update started by FBRX OS itself, or the elevated copy of Setup started after the
      ; choice was made.
      ${If} $fbrxInstalled == ""
      ${OrIf} ${isUpdated}
      ${OrIf} ${UAC_IsInnerInstance}
        Abort
      ${EndIf}
      StrCpy $fbrxRadioMain ""
      StrCpy $fbrxRadioRepair ""

      !insertmacro MUI_HEADER_TEXT "${PRODUCT_NAME} is already installed" "Installed: version $fbrxInstalled.  This Setup: version ${VERSION}."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 0 100% 18u "Choose what to do. If ${PRODUCT_NAME} is open, Setup closes it for you first."
      Pop $0

      ${If} $fbrxCompare == 1
        ${NSD_CreateRadioButton} 0 22u 100% 11u "&Upgrade to version ${VERSION} (recommended)"
        Pop $fbrxRadioMain
        ${NSD_CreateLabel} 12u 34u -12u 10u "Your data, settings, license and paired devices are kept."
        Pop $0
        ${NSD_CreateRadioButton} 0 48u 100% 11u "&Repair"
        Pop $fbrxRadioRepair
        ${NSD_CreateLabel} 12u 60u -12u 18u "Installs version ${VERSION} from scratch and clears cached files. Use this if ${PRODUCT_NAME} does not start or looks wrong. Your data is kept."
        Pop $0
      ${ElseIf} $fbrxCompare == 0
        ${NSD_CreateRadioButton} 0 22u 100% 11u "&Repair version ${VERSION}"
        Pop $fbrxRadioRepair
        ${NSD_CreateLabel} 12u 34u -12u 18u "Reinstalls the program files and clears cached files. Use this if ${PRODUCT_NAME} does not start or looks wrong. Your data is kept."
        Pop $0
      ${Else}
        ${NSD_CreateRadioButton} 0 22u 100% 11u "&Downgrade to version ${VERSION}"
        Pop $fbrxRadioMain
        ${NSD_CreateLabel} 12u 34u -12u 26u "Not recommended. Version $fbrxInstalled may have saved data that this older version cannot read. Make a backup first (Backup & restore in ${PRODUCT_NAME})."
        Pop $0
      ${EndIf}

      ${NSD_CreateRadioButton} 0 84u 100% 11u "Un&install ${PRODUCT_NAME}"
      Pop $fbrxRadioRemove
      ${NSD_CreateCheckBox} 12u 97u -12u 11u "Also delete &my data from this computer"
      Pop $fbrxCheckData
      ${NSD_CreateLabel} 24u 109u -24u 18u "Tasks, notes, chats, settings, saved credentials, downloaded AI models and backups kept in the data folder. This cannot be undone."
      Pop $0
      EnableWindow $fbrxCheckData 0

      ${NSD_OnClick} $fbrxRadioRemove fbrxMaintenanceChoice
      ${If} $fbrxRadioMain != ""
        ${NSD_OnClick} $fbrxRadioMain fbrxMaintenanceChoice
      ${EndIf}
      ${If} $fbrxRadioRepair != ""
        ${NSD_OnClick} $fbrxRadioRepair fbrxMaintenanceChoice
      ${EndIf}

      ; Preselect the safe choice; a downgrade must be picked explicitly.
      ${If} $fbrxCompare == 1
        ${NSD_Check} $fbrxRadioMain
      ${ElseIf} $fbrxCompare == 0
        ${NSD_Check} $fbrxRadioRepair
      ${Else}
        GetDlgItem $0 $HWNDPARENT 1
        EnableWindow $0 0
      ${EndIf}
      nsDialogs::Show
    FunctionEnd

    Function fbrxMaintenanceChoice
      Pop $0
      GetDlgItem $0 $HWNDPARENT 1
      EnableWindow $0 1
      ${NSD_GetState} $fbrxRadioRemove $0
      ${If} $0 == ${BST_CHECKED}
        EnableWindow $fbrxCheckData 1
        GetDlgItem $0 $HWNDPARENT 1
        SendMessage $0 ${WM_SETTEXT} 0 "STR:Uninstall"
      ${Else}
        ${NSD_Uncheck} $fbrxCheckData
        EnableWindow $fbrxCheckData 0
        GetDlgItem $0 $HWNDPARENT 1
        SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^NextBtn)"
      ${EndIf}
    FunctionEnd

    Function fbrxMaintenanceLeave
      ${NSD_GetState} $fbrxRadioRemove $0
      ${If} $0 == ${BST_CHECKED}
        ${NSD_GetState} $fbrxCheckData $0
        ${If} $0 == ${BST_CHECKED}
          ${IfNot} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Delete ${PRODUCT_NAME} and all of its data from this computer?$\r$\n$\r$\nThis cannot be undone. Make a backup first if you might need anything." IDYES`
            Abort
          ${EndIf}
          StrCpy $fbrxRemoveData 1
        ${Else}
          StrCpy $fbrxRemoveData 0
        ${EndIf}
        Call fbrxUninstall
        ${If} $fbrxRemoveData == 1
          MessageBox MB_ICONINFORMATION "${PRODUCT_NAME} and its data have been removed from this computer."
        ${Else}
          MessageBox MB_ICONINFORMATION "${PRODUCT_NAME} has been uninstalled.$\r$\n$\r$\nYour data was kept in $APPDATA\${PRODUCT_FILENAME}, so a later reinstall picks up where you left off."
        ${EndIf}
        !insertmacro quitSuccess
      ${EndIf}

      ${If} $fbrxRadioRepair != ""
        ${NSD_GetState} $fbrxRadioRepair $0
        ${If} $0 == ${BST_CHECKED}
          !insertmacro customCheckAppRunning
          Call fbrxClearCaches
        ${EndIf}
      ${EndIf}

      ; Keep the installation's folder: go straight to the progress page. An installation for all users needs
      ; administrator rights first, which the install-mode page that follows asks for.
      ${If} $installMode == "CurrentUser"
      ${OrIf} ${UAC_IsAdmin}
        SendMessage $HWNDPARENT 0x408 ${FBRX_TO_PROGRESS} 0
        Abort
      ${EndIf}
    FunctionEnd

    ; Runs the installed uninstaller without questions. Sets the error level and quits when it fails.
    Function fbrxUninstall
      !insertmacro customCheckAppRunning
      ${IfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
        MessageBox MB_ICONSTOP "The ${PRODUCT_NAME} uninstaller is missing from $INSTDIR. Choose Repair first, then uninstall." /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
      CopyFiles /SILENT "$INSTDIR\${UNINSTALL_FILENAME}" "$PLUGINSDIR\fbrx-uninstall.exe"
      ${If} $installMode == "all"
        StrCpy $1 "/allusers"
      ${Else}
        StrCpy $1 "/currentuser"
      ${EndIf}
      ${If} $fbrxRemoveData == 1
        StrCpy $1 "$1 --delete-app-data"
      ${Else}
        StrCpy $1 "$1 /KEEP_APP_DATA"
      ${EndIf}
      ; Leave the folder, so the uninstaller can delete it.
      SetOutPath $TEMP
      ${If} $installMode == "all"
      ${AndIfNot} ${UAC_IsAdmin}
        ; Installed for all users: the uninstaller's own window asks for administrator rights.
        ExecWait `"$PLUGINSDIR\fbrx-uninstall.exe" $1 _?=$INSTDIR` $0
      ${Else}
        ExecWait `"$PLUGINSDIR\fbrx-uninstall.exe" /S $1 _?=$INSTDIR` $0
      ${EndIf}
      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        MessageBox MB_ICONSTOP "${PRODUCT_NAME} could not be uninstalled (error $0)." /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
      RMDir "$INSTDIR"
    FunctionEnd

    ; Chromium caches in the app's data folder; deleting them fixes most start-up and display problems.
    Function fbrxClearCaches
      SetShellVarContext current
      StrCpy $0 "$APPDATA\${PRODUCT_FILENAME}"
      RMDir /r "$0\Cache"
      RMDir /r "$0\Code Cache"
      RMDir /r "$0\GPUCache"
      RMDir /r "$0\DawnCache"
      RMDir /r "$0\DawnGraphiteCache"
      RMDir /r "$0\DawnWebGPUCache"
      RMDir /r "$0\ShaderCache"
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
    FunctionEnd

    ; License key carried by this Setup, or saved next to it, for the app to activate on its next start.
    Function fbrxDropLicense
      SetShellVarContext current
      StrCpy $0 "$APPDATA\${PRODUCT_FILENAME}"
      !ifdef FBRX_EMBEDDED_LICENSE
        CreateDirectory "$0"
        FileOpen $1 "$0\fbrx-license.key" w
        FileWrite $1 "${FBRX_EMBEDDED_LICENSE}$\r$\n"
        FileClose $1
      !endif
      ${If} ${FileExists} "$EXEDIR\fbrx-license.key"
        CreateDirectory "$0"
        CopyFiles /SILENT "$EXEDIR\fbrx-license.key" "$0\fbrx-license.key"
      ${EndIf}
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
    FunctionEnd
  !else
    Function un.fbrxDeleteData
      SetShellVarContext current
      RMDir /r "$APPDATA\${PRODUCT_FILENAME}"
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
    FunctionEnd
  !endif
!macroend

; ------------------------------------------------------------------------------------------- after installing

!macro customInstall
  ${If} ${Silent}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/REPAIR" $R1
    ${IfNot} ${Errors}
      Call fbrxClearCaches
    ${EndIf}
  ${EndIf}
  Call fbrxDropLicense
!macroend

; ------------------------------------------------------------------------------------------- uninstaller

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "This removes ${PRODUCT_NAME} from your computer. If it is open, it is closed for you.$\r$\n$\r$\nYou can choose to keep your data (tasks, notes, chats and settings) for a later reinstall.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; Uninstalling from Windows Settings asks whether to delete the data too (default: keep it).
!macro customUnInstall
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    ; Skip the question when the command line already decided (Setup's own uninstall passes one of these).
    ${GetParameters} $R0
    StrCpy $R2 0
    ClearErrors
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${IfNot} ${Errors}
      StrCpy $R2 1
    ${EndIf}
    ClearErrors
    ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
    ${IfNot} ${Errors}
      StrCpy $R2 1
    ${EndIf}
    ${If} $R2 == 0
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your ${PRODUCT_NAME} data from this computer?$\r$\n$\r$\nThis removes your tasks, notes, chats, settings, saved credentials, downloaded AI models and the backups kept in the data folder. It cannot be undone.$\r$\n$\r$\nChoose No to keep them for a later reinstall." IDYES`
        Call un.fbrxDeleteData
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
