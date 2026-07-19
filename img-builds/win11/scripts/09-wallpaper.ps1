$ErrorActionPreference = "Stop"

$src = "C:\packer\wallpaper.png"
if (-not (Test-Path $src)) { Write-Host "No wallpaper uploaded; skipping."; exit 0 }

$dst = "C:\Windows\Web\Wallpaper\golden.png"
Copy-Item $src $dst -Force

# WallpaperStyle 10 = Fill, TileWallpaper 0. Set as default, not policy, so
# users can still change it.
# Administrator (this WinRM session's user) is the account clones log into;
# its profile already exists, so the Default-hive copy below won't reach it.
foreach ($n in @{ Wallpaper = $dst; WallpaperStyle = "10"; TileWallpaper = "0" }.GetEnumerator()) {
  Set-ItemProperty "HKCU:\Control Panel\Desktop" -Name $n.Key -Value $n.Value
}

# Default user profile: any future account starts with the wallpaper too.
reg load HKU\GoldenDefault C:\Users\Default\NTUSER.DAT | Out-Null
try {
  foreach ($n in @{ Wallpaper = $dst; WallpaperStyle = "10"; TileWallpaper = "0" }.GetEnumerator()) {
    New-ItemProperty -Path "Registry::HKU\GoldenDefault\Control Panel\Desktop" `
      -Name $n.Key -Value $n.Value -PropertyType String -Force | Out-Null
  }
} finally {
  [gc]::Collect()  # release hive handles so the unload doesn't fail
  Start-Sleep 1
  reg unload HKU\GoldenDefault | Out-Null
}
# Lock screen: the "force default lock screen image" group policy is
# Enterprise/Education-only, so use the PersonalizationCSP keys (the MDM
# mechanism), which work on Pro. Trade-off: this pins the lock screen image
# (Settings shows it as managed), unlike the user-changeable wallpaper above.
$csp = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\PersonalizationCSP"
New-Item -Path $csp -Force | Out-Null
Set-ItemProperty $csp -Name LockScreenImagePath   -Value $dst -Type String
Set-ItemProperty $csp -Name LockScreenImageUrl    -Value $dst -Type String
Set-ItemProperty $csp -Name LockScreenImageStatus -Value 1    -Type DWord

Write-Host "Wallpaper + lock screen baked: $dst"
