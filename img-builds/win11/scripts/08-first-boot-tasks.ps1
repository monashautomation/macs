$ErrorActionPreference = "Stop"

$dir = "C:\ProgramData\golden"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
foreach ($f in "activate-hwid.ps1","netbird-join.ps1","remote-allow.ps1","sunshine-config.ps1","sunshine-pair.ps1") {
  Copy-Item "C:\packer\$f" (Join-Path $dir $f) -Force
}
Write-Host "First-boot helpers staged under $dir."

# User-facing command: `sunshine-pair` runs by bare name from cmd AND
# PowerShell. Only a .cmd shim goes on PATH (not the .ps1): PowerShell would
# otherwise prefer a .ps1 on PATH and run it under the machine execution
# policy, which is Restricted on stock Win11. The shim invokes the .ps1 by
# absolute path with -ExecutionPolicy Bypass, so it works regardless of the
# machine policy and needs no global policy change.
$bin = Join-Path $dir "bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Set-Content -Path (Join-Path $bin "sunshine-pair.cmd") -Encoding ASCII -Value @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\sunshine-pair.ps1" %*
"@
$path = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($path -notlike "*$bin*") {
  [Environment]::SetEnvironmentVariable("Path", "$path;$bin", "Machine")
}
Write-Host "sunshine-pair installed to $bin (on machine PATH)."
