# Pair a Moonlight client with this VM's Sunshine instance.
# Usage: sunshine-pair [client-name]
# Web UI credentials: SUNSHINE_USER (default: current user) and
# SUNSHINE_PASS (prompted when unset).
param([string]$Name = "moonlight-client")

$ErrorActionPreference = "Stop"

$pin = Read-Host 'Enter Moonlight PIN'

$user = if ($env:SUNSHINE_USER) { $env:SUNSHINE_USER } else { $env:USERNAME }
if ($env:SUNSHINE_PASS) {
  $pass = $env:SUNSHINE_PASS
} else {
  $sec  = Read-Host "Sunshine web UI password for $user" -AsSecureString
  $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

# Pairing goes through the web UI API (HTTPS, self-signed cert, basic auth).
# curl.exe ships with Windows 11. The JSON body goes via a temp file:
# Windows PowerShell 5.1 mangles quoted JSON when passing it as an argument
# to native executables.
$body = @{ pin = "$pin"; name = "$Name" } | ConvertTo-Json -Compress
$tmp  = New-TemporaryFile
try {
  Set-Content -Path $tmp -Value $body -Encoding ASCII -NoNewline
  curl.exe -fsk -u "${user}:${pass}" -X POST https://localhost:47990/api/pin `
    -H "Content-Type: application/json" -d "@$tmp"
  if ($LASTEXITCODE -ne 0) { throw "pairing request failed (exit $LASTEXITCODE)" }
  Write-Host ""
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
