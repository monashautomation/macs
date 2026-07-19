$ErrorActionPreference = "Stop"

$msi = "C:\packer\CloudbaseInitSetup.msi"
$url = "https://github.com/cloudbase/cloudbase-init/releases/download/1.1.6/CloudbaseInitSetup_1_1_6_x64.msi"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ok = $false
for ($i = 1; $i -le 3; $i++) {
  try { Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing; $ok = $true; break }
  catch { Write-Warning "download attempt $i failed: $($_.Exception.Message)"; Start-Sleep 5 }
}
if (-not $ok) { throw "Cloudbase-Init download failed after retries" }

Write-Host "Installing Cloudbase-Init ..."
$p = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$msi`" /qn /norestart RUN_SERVICE_AS_LOCAL_SYSTEM=1" -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Cloudbase-Init install failed: exit $($p.ExitCode)" }

# Drop in our datasource config (uploaded to C:\packer\ by Packer).
$cbDir = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf"
Copy-Item "C:\packer\cloudbase-init.conf"          (Join-Path $cbDir "cloudbase-init.conf")          -Force
Copy-Item "C:\packer\cloudbase-init-unattend.conf" (Join-Path $cbDir "cloudbase-init-unattend.conf") -Force
Write-Host "Cloudbase-Init installed + configured."
