$ErrorActionPreference = "Stop"

# Find the virtio-win ISO's CD (drive letter is not fixed and the volume
# label carries a version suffix, so probe by content).
$virtio = $null
foreach ($v in (Get-Volume | Where-Object DriveType -eq "CD-ROM")) {
  if (-not $v.DriveLetter) { continue }
  $root = $v.DriveLetter + ":\"
  if (Test-Path (Join-Path $root "NetKVM")) { $virtio = $root; break }
}
if (-not $virtio) { throw "virtio-win CD not found on any CD-ROM volume" }

# All-in-one guest tools when the ISO ships it; otherwise the standalone
# guest-agent MSI (bootstrap-winrm.ps1 already installed the NIC driver).
$tools = Join-Path $virtio "virtio-win-guest-tools.exe"
$gaMsi = Join-Path $virtio "guest-agent\qemu-ga-x86_64.msi"
if (Test-Path $tools) {
  Write-Host "Installing virtio guest tools from $tools ..."
  $p = Start-Process -FilePath $tools -ArgumentList "/install /quiet /norestart" -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "virtio guest tools failed: exit $($p.ExitCode)" }
} elseif (Test-Path $gaMsi) {
  Write-Host "No guest-tools exe on this ISO; installing guest agent MSI from $gaMsi ..."
  $p = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$gaMsi`" /qn /norestart" -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "guest agent MSI failed: exit $($p.ExitCode)" }
} else {
  throw "no guest tools installer found on $virtio"
}

# QEMU guest agent should now be present; make sure it runs.
Set-Service -Name "QEMU-GA" -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service -Name "QEMU-GA" -ErrorAction SilentlyContinue
Write-Host "virtio guest tools installed."
