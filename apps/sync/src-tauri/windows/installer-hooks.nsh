; HQ installer hooks — Windows (NSIS).
;
; Field failure 2026-08-02: a background update ran this installer while
; hq-sync-menubar.exe and processes spawned from the install directory were
; still running. NSIS cannot overwrite open files, so the install died
; mid-copy ("Error opening file for writing: …\hq-sync-menubar.exe"), leaving
; a half-removed app whose uninstaller was also broken. These hooks stop every
; HQ process running from $INSTDIR before any file is touched — on install
; AND uninstall — so a fresh setup self-heals over that corrupted state.
;
; Scope discipline: never kill by generic image name (a bare node.exe kill
; would take out unrelated user processes). The PowerShell sweep matches on
; ExecutablePath under $INSTDIR only; the taskkill fast paths name
; HQ-unique executables.

!macro HQ_STOP_INSTALL_DIR_PROCESSES
  DetailPrint "Stopping running HQ processes"
  ; No /T on the app kill: when the in-app updater launches this installer,
  ; the installer IS a descendant of hq-sync-menubar.exe — a tree kill would
  ; terminate the running installer itself. Children that matter are caught
  ; by the $INSTDIR-scoped sweep below.
  nsExec::ExecToLog 'taskkill /F /IM "hq-sync-menubar.exe"'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM "recall-desktop-sdk.exe"'
  Pop $0
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$null -ne $$_.ExecutablePath -and $$_.ExecutablePath -like \"$INSTDIR\*\" } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro HQ_STOP_INSTALL_DIR_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro HQ_STOP_INSTALL_DIR_PROCESSES
!macroend
