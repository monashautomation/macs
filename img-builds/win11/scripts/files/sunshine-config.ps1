param(
  # Sunshine web-UI password (username defaults to "sunshine"). If empty, only
  # the CSRF origins are written and the credential is left for interactive setup.
  [string]$Password = "",
  [string]$User = "sunshine"
)
$ErrorActionPreference = "Continue"
$conf = "C:\Program Files\Sunshine\config\sunshine.conf"
$exe  = "C:\Program Files\Sunshine\sunshine.exe"

# Sunshine's CSRF protection only trusts localhost by default, so the Web UI is
# blocked when reached by the NetBird FQDN or the VM's LAN/overlay IP. Trust
# this VM's real NetBird FQDN (read live from the client) plus every non-loopback
# IPv4, on the Web UI port 47990.
$fqdn = ((& 'C:\Program Files\NetBird\netbird.exe' status 2>$null | Select-String 'FQDN') -replace '.*FQDN:\s*','').Trim()
$ips  = (Get-NetIPAddress -AddressFamily IPv4 |
          Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress
$origins = (@($fqdn) + @($ips) | Where-Object { $_ } | ForEach-Object { "https://${_}:47990" }) -join ','

Stop-Service SunshineService -Force -ErrorAction SilentlyContinue
Start-Sleep 2
Set-Content -Path $conf -Value "csrf_allowed_origins = $origins" -Encoding ASCII
if ($Password) { & $exe --creds $User $Password 2>&1 | Out-Null }
Start-Service SunshineService
Write-Host "Sunshine configured. csrf_allowed_origins = $origins"
