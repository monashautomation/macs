$ErrorActionPreference = "Stop"

$dir = "C:\ProgramData\golden"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
foreach ($f in "activate-hwid.ps1","netbird-join.ps1","remote-allow.ps1","sunshine-config.ps1") {
  Copy-Item "C:\packer\$f" (Join-Path $dir $f) -Force
}
Write-Host "First-boot helpers staged under $dir."

# User-facing commands: sunshine-pair runs from any shell by bare name.
# PowerShell resolves the .ps1 from PATH directly; the .cmd shim covers
# cmd.exe (PATHEXT has no .PS1).
$bin = Join-Path $dir "bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Copy-Item "C:\packer\sunshine-pair.ps1" (Join-Path $bin "sunshine-pair.ps1") -Force
Set-Content -Path (Join-Path $bin "sunshine-pair.cmd") -Encoding ASCII -Value @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dpn0.ps1" %*
'@
$path = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($path -notlike "*$bin*") {
  [Environment]::SetEnvironmentVariable("Path", "$path;$bin", "Machine")
}
Write-Host "sunshine-pair installed to $bin (on machine PATH)."
