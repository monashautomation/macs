$ErrorActionPreference = "Stop"

$version = $env:SUNSHINE_VERSION
if ([string]::IsNullOrWhiteSpace($version)) { throw "SUNSHINE_VERSION not set" }

# Asset is Sunshine-Windows-AMD64-installer.exe (NSIS) on the LizardByte release.
$url = "https://github.com/LizardByte/Sunshine/releases/download/$version/Sunshine-Windows-AMD64-installer.exe"
$exe = "C:\packer\sunshine-installer.exe"
Write-Host "Downloading Sunshine $version ..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ok = $false
for ($i = 1; $i -le 3; $i++) {
  try { Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing; $ok = $true; break }
  catch { Write-Warning "download attempt $i failed: $($_.Exception.Message)"; Start-Sleep 5 }
}
if (-not $ok) { throw "Sunshine download failed after retries" }

# Silent install (NSIS). Installs the Sunshine service + ViGEmBus virtual gamepad.
$p = Start-Process -FilePath $exe -ArgumentList "/S" -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Sunshine install failed: exit $($p.ExitCode)" }

# The NSIS installer registers its own any-source "Sunshine" firewall rules,
# which would leave streaming + the Web UI reachable from the LAN no matter how
# our rules are scoped. Remove them; only the overlay-scoped rules below stay.
Get-NetFirewallRule -DisplayName "Sunshine" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# Firewall for Moonlight/Sunshine (TCP+UDP 47984-48010), scoped to the NetBird
# CGNAT overlay (100.64.0.0/10) so streaming is reachable only over the tunnel,
# never from the LAN - same "via NetBird only" policy as RDP (see remote-allow.ps1).
$overlay = "100.64.0.0/10"
New-NetFirewallRule -DisplayName "Sunshine-TCP" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 47984-48010 -RemoteAddress $overlay -Profile Any -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName "Sunshine-UDP" -Direction Inbound -Action Allow `
  -Protocol UDP -LocalPort 47998-48010 -RemoteAddress $overlay -Profile Any -ErrorAction SilentlyContinue | Out-Null
Write-Host "Sunshine installed."
