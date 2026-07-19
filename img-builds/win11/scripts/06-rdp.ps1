$ErrorActionPreference = "Stop"

# Enable RDP + Network Level Authentication.
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server" `
  -Name "fDenyTSConnections" -Value 0
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" `
  -Name "UserAuthentication" -Value 1

# Disable the built-in Remote Desktop firewall rules so only the scoped rule
# created at first boot can permit RDP.
Get-NetFirewallRule -Group "@FirewallAPI.dll,-28752" -ErrorAction SilentlyContinue |
  Set-NetFirewallRule -Enabled False

# NO allow rule is created here: RDP ships CLOSED. The correct source is the
# NetBird ROUTING PEER's LAN address, because NetBird reaches these VMs by
# routing their LAN subnet and masquerading traffic to the routing peer's IP -
# so RDP arrives at the VM's LAN IP FROM the router, never from a 100.x overlay
# address. That router IP is deploy-specific, so the allow rule is created at
# first boot by C:\ProgramData\golden\remote-allow.ps1 (staged by 08), which the
# Cloudbase-Init user-data calls with the router address. Fails closed until
# then. (SSH is served by NetBird's overlay SSH, not a Windows port-22 rule.)
Write-Host "RDP enabled + NLA; default rules disabled. Allow rule deferred to first boot."
