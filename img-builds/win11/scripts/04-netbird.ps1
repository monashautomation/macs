$ErrorActionPreference = "Stop"

$version = $env:NETBIRD_VERSION
if ([string]::IsNullOrWhiteSpace($version)) { throw "NETBIRD_VERSION not set" }

$url = "https://github.com/netbirdio/netbird/releases/download/v$version/netbird_installer_${version}_windows_amd64.exe"
$exe = "C:\packer\netbird-installer.exe"
Write-Host "Downloading NetBird $version ..."
Invoke-WebRequest -Uri $url -OutFile $exe

# Silent install. NetBird is installed but NOT joined here: `netbird up` with
# the per-VM setup key runs on the clone's first boot via Cloudbase-Init.
$p = Start-Process -FilePath $exe -ArgumentList "/S" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "NetBird install failed: exit $($p.ExitCode)" }
Write-Host "NetBird installed (not joined)."
