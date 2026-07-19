param(
  [Parameter(Mandatory=$true)][string]$SetupKey,
  [Parameter(Mandatory=$true)][string]$Hostname,
  [string]$ManagementUrl = ""
)
$ErrorActionPreference = "Stop"
$nb = "C:\Program Files\NetBird\netbird.exe"
# NetBird's built-in SSH server over the overlay (reach with `netbird ssh`):
#   --allow-server-ssh  run the SSH server on this peer
#   --disable-ssh-auth  authenticate by the NetBird network ACL only, not JWT/SSO
#                       (0.70's JWT SSH needs management OIDC config; ACL matches
#                       how access is gated everywhere else here)
#   --enable-ssh-root   allow the privileged Administrator account to log in
#                       (otherwise "privileged user access is disabled")
$nbArgs = @("up", "--setup-key", $SetupKey, "--hostname", $Hostname,
            "--allow-server-ssh", "--disable-ssh-auth", "--enable-ssh-root")
if ($ManagementUrl -ne "") { $nbArgs += @("--management-url", $ManagementUrl) }
& $nb @nbArgs
