$ErrorActionPreference = "Continue"
# MAS HWID digital-license activation. Runs per-clone (hardware-bound license),
# never at build time. Needs internet.
#
# Two hardening measures, both learned from first-boot runs on clones:
# - MAS runs in a CHILD powershell: the script calls `exit`, which would kill
#   the calling host (and with it the rest of the first-boot user-data).
# - Verify + retry: activation right after the NetBird join can fail while the
#   network stack is still settling; a later retry succeeds.
for ($i = 1; $i -le 3; $i++) {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `
    '& ([ScriptBlock]::Create((Invoke-RestMethod -Uri "https://get.activated.win"))) /HWID'
  $status = cscript //nologo "$env:windir\System32\slmgr.vbs" /xpr
  if ($status -match "permanently activated") { Write-Host "Activated."; exit 0 }
  Write-Warning "activation attempt $i did not stick; retrying in 30s"
  Start-Sleep 30
}
Write-Warning "HWID activation failed after retries; re-run C:\ProgramData\golden\activate-hwid.ps1 manually."
