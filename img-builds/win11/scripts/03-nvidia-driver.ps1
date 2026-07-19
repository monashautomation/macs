$ErrorActionPreference = "Stop"

$installer = "C:\packer\nvidia.exe"
if (-not (Test-Path $installer)) {
  Write-Host "No NVIDIA installer uploaded (nvidia_driver_path empty); skipping."
  return
}

# 7-Zip to unpack the driver package (the build VM has no GPU, so we cannot
# run the installer itself; we only need its Display.Driver INFs).
$sevenZip = "C:\packer\7zr.exe"
Invoke-WebRequest -Uri "https://www.7-zip.org/a/7zr.exe" -OutFile $sevenZip

$extract = "C:\packer\nvidia"
& $sevenZip x $installer "-o$extract" -y | Out-Null

# Inject every Display.Driver INF into the driver store. When a clone boots
# with a passed-through GPU, PnP installs it automatically.
$infs = Get-ChildItem -Path (Join-Path $extract "Display.Driver") -Filter *.inf -Recurse -ErrorAction Stop
if (-not $infs) { throw "No Display.Driver INFs found under $extract" }
foreach ($inf in $infs) {
  Write-Host "pnputil add-driver $($inf.FullName)"
  pnputil /add-driver $inf.FullName /install | Out-Null
}
Write-Host "NVIDIA driver staged into driver store."
