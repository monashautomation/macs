# Runs at first logon (via Autounattend FirstLogonCommands). Installs the
# virtio NIC driver + guest agent, then enables WinRM for the Packer
# communicator. Order matters twice over: WinPE DriverPaths only reflects
# BOOT-CRITICAL drivers (vioscsi) into the installed image, so the installed
# OS wakes up with no NIC at all until NetKVM goes in here - and the Proxmox
# plugin discovers the VM's IP through the guest agent, so without both of
# them Packer waits on WinRM forever.
$ErrorActionPreference = "Continue"
Start-Transcript -Path "C:\Windows\Temp\bootstrap-winrm.log" -Append

# --- locate the virtio-win CD (drive letter is not fixed and the volume
# label carries a version suffix, so find it by content, not name) ---
$virtio = $null
foreach ($v in (Get-Volume | Where-Object DriveType -eq "CD-ROM")) {
  if (-not $v.DriveLetter) { continue }
  $root = $v.DriveLetter + ":\"
  if (Test-Path (Join-Path $root "NetKVM")) { $virtio = $root; break }
}
if (-not $virtio) { Write-Host "WARNING: no virtio-win CD found" }

if ($virtio) {
  # NIC driver directly via pnputil (w11 dir preferred, w10 works on Win11
  # and covers older virtio-win ISOs that predate the w11 layout).
  $inf = @("NetKVM\w11\amd64\netkvm.inf", "NetKVM\w10\amd64\netkvm.inf") |
    ForEach-Object { Join-Path $virtio $_ } | Where-Object { Test-Path $_ } |
    Select-Object -First 1
  if ($inf) {
    Write-Host "Installing NIC driver: $inf"
    pnputil.exe /add-driver $inf /install
  } else {
    Write-Host "WARNING: netkvm.inf not found on $virtio"
  }

  # Guest agent + remaining drivers: the all-in-one installer when the ISO
  # ships it, otherwise the standalone guest-agent MSI (present on old ISOs).
  $tools = Join-Path $virtio "virtio-win-guest-tools.exe"
  $gaMsi = Join-Path $virtio "guest-agent\qemu-ga-x86_64.msi"
  if (Test-Path $tools) {
    Write-Host "Installing guest tools: $tools"
    Start-Process -FilePath $tools -ArgumentList "/install /quiet /norestart" -Wait
  } elseif (Test-Path $gaMsi) {
    Write-Host "No guest-tools exe; installing guest agent MSI: $gaMsi"
    Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$gaMsi`" /qn /norestart" -Wait
  } else {
    Write-Host "WARNING: no guest tools installer found on $virtio"
  }
}
Set-Service -Name "QEMU-GA" -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service -Name "QEMU-GA" -ErrorAction SilentlyContinue

# --- WinRM over HTTP for the Packer communicator ---
Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue
winrm quickconfig -quiet
winrm set winrm/config/service '@{AllowUnencrypted="true"}'
winrm set winrm/config/service/auth '@{Basic="true"}'
winrm set winrm/config/winrs '@{MaxMemoryPerShellMB="1024"}'
Set-Service -Name WinRM -StartupType Automatic
Start-Service -Name WinRM
New-NetFirewallRule -DisplayName "WinRM-HTTP-In-Build" -Name "WinRM-HTTP-In-Build" `
  -Protocol TCP -LocalPort 5985 -Action Allow -Direction Inbound -Enabled True -ErrorAction SilentlyContinue

Stop-Transcript
