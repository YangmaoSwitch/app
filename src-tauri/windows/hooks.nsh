; Uninstall: when the user ticks "delete app data", also remove the API keys
; saved in Windows Credential Manager. Skipped during updates.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ExecWait '"$INSTDIR\yangmao-switch.exe" --purge'
  ${EndIf}
!macroend
