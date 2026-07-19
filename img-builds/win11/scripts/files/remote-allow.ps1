param(
  # Extra source address(es) to allow beyond the NetBird overlay, as a single
  # IP, CIDR, or comma-separated list. Normally omitted: access is meant to come
  # in over the NetBird tunnel only. Kept for edge cases (e.g. a specific extra
  # peer/route) without reopening RDP to the LAN.
  [string]$Source = ""
)
$ErrorActionPreference = "Stop"

# NetBird's CGNAT overlay range. Traffic from these addresses can only arrive
# through the NetBird tunnel (interface wt0), never from arbitrary LAN hosts, so
# scoping the rules here satisfies "RDP/ping over NetBird only, not the LAN".
# It also covers BOTH overlay paths: the direct peer-to-peer path (the peer's own
# 100.x address, i.e. the netbird DNS name) and any routed/masqueraded path.
$overlay = "100.64.0.0/10"
$remote  = @($overlay)
if ($Source -ne "") { $remote += ($Source -split ',') }

# RDP (3389). Ships closed in the template (06-rdp.ps1 disables the default
# rules); this per-clone rule is the only inbound path to 3389.
Remove-NetFirewallRule -Name 'NetBird-RemoteAccess' -ErrorAction SilentlyContinue
Remove-NetFirewallRule -Name 'RDP-NetBird-Only'    -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'NetBird-RemoteAccess' -Name 'NetBird-RemoteAccess' `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 `
  -RemoteAddress $remote -Profile Any -Enabled True | Out-Null

# ICMPv4 Echo Request so the peer answers ping over the overlay. Windows blocks
# inbound echo by default on every profile (including Private), so without this
# rule `ping <netbird-name>` times out even when the tunnel is up.
Remove-NetFirewallRule -Name 'NetBird-Ping' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'NetBird-Ping' -Name 'NetBird-Ping' `
  -Direction Inbound -Action Allow -Protocol ICMPv4 -IcmpType 8 `
  -RemoteAddress $remote -Profile Any -Enabled True | Out-Null

Write-Host "RDP(3389)+ICMP allowed from: $($remote -join ',')"
