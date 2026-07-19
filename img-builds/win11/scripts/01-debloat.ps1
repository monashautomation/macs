$ErrorActionPreference = "Stop"

# Stop Windows Update for the duration of the build so it can't race the
# installers that follow. 07/seal re-enables it.
Write-Host "Disabling Windows Update during build..."
Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
Set-Service  -Name wuauserv -StartupType Disabled

# Remove provisioned + installed Appx bloat. Explicit list; a package that is
# already absent is a warning, not a failure (survives Windows image revisions).
$removeAppx = @(
  "Microsoft.XboxGamingOverlay","Microsoft.XboxGameOverlay","Microsoft.Xbox.TCUI",
  "Microsoft.XboxIdentityProvider","Microsoft.XboxSpeechToTextOverlay","Microsoft.GamingApp",
  "Microsoft.MicrosoftSolitaireCollection","Microsoft.BingNews","Microsoft.BingWeather",
  "Microsoft.BingSearch","Microsoft.WindowsFeedbackHub","Microsoft.GetHelp","Microsoft.Getstarted",
  "Microsoft.WindowsMaps","Microsoft.People","Microsoft.Todos","Microsoft.PowerAutomateDesktop",
  "Microsoft.Clipchamp","Microsoft.Teams","MicrosoftTeams","Microsoft.Windows.DevHome",
  "Microsoft.OutlookForWindows","Microsoft.549981C3F5F10","MicrosoftCorporationII.QuickAssist",
  "Microsoft.MicrosoftOfficeHub","Microsoft.MixedReality.Portal","Microsoft.ZuneMusic","Microsoft.ZuneVideo"
)
foreach ($name in $removeAppx) {
  try {
    Get-AppxPackage -AllUsers -Name $name | Remove-AppxPackage -AllUsers -ErrorAction Stop
    Get-AppxProvisionedPackage -Online | Where-Object DisplayName -eq $name |
      Remove-AppxProvisionedPackage -Online -ErrorAction Stop | Out-Null
    Write-Host "Removed $name"
  } catch { Write-Warning "Skip ${name}: $($_.Exception.Message)" }
}

# Registry tweaks: telemetry, ads, consumer experiences, Start web search, Edge nags.
$reg = @(
  @{ Path="HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection"; Name="AllowTelemetry"; Type="DWord"; Value=0 },
  @{ Path="HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent"; Name="DisableWindowsConsumerFeatures"; Type="DWord"; Value=1 },
  @{ Path="HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent"; Name="DisableConsumerAccountStateContent"; Type="DWord"; Value=1 },
  @{ Path="HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search"; Name="DisableWebSearch"; Type="DWord"; Value=1 },
  @{ Path="HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search"; Name="ConnectedSearchUseWeb"; Type="DWord"; Value=0 },
  @{ Path="HKLM:\SOFTWARE\Policies\Microsoft\Edge"; Name="HideFirstRunExperience"; Type="DWord"; Value=1 },
  @{ Path="HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AdvertisingInfo"; Name="Enabled"; Type="DWord"; Value=0 }
)
foreach ($r in $reg) {
  if (-not (Test-Path $r.Path)) { New-Item -Path $r.Path -Force | Out-Null }
  New-ItemProperty -Path $r.Path -Name $r.Name -PropertyType $r.Type -Value $r.Value -Force | Out-Null
}

# Disable telemetry services + tasks.
foreach ($svc in @("DiagTrack","dmwappushservice")) {
  Stop-Service  -Name $svc -Force -ErrorAction SilentlyContinue
  Set-Service   -Name $svc -StartupType Disabled -ErrorAction SilentlyContinue
}
foreach ($t in @(
  "\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser",
  "\Microsoft\Windows\Customer Experience Improvement Program\Consolidator",
  "\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip")) {
  Disable-ScheduledTask -TaskPath (Split-Path $t) -TaskName (Split-Path $t -Leaf) -ErrorAction SilentlyContinue | Out-Null
}

# VM tuning: no hibernation, high-performance power plan.
powercfg /hibernate off
powercfg /setactive SCHEME_MIN
Write-Host "Debloat complete."
