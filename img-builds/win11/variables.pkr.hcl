# variables.pkr.hcl
# ──────────────────────────────────────────────────────────────────────────────
# Proxmox connection and target
# ──────────────────────────────────────────────────────────────────────────────
variable "proxmox_host" { type = string }
variable "proxmox_node" { type = string }
variable "proxmox_username" { type = string }
variable "proxmox_token" {
  type      = string
  sensitive = true
}

# ──────────────────────────────────────────────────────────────────────────────
# Proxmox placement
# ──────────────────────────────────────────────────────────────────────────────
variable "pool" {
  type        = string
  default     = "packer-build"
  description = "Proxmox resource pool the build VM is created in (must exist)"
}

variable "network_bridge" {
  type        = string
  default     = "vmbr1"
  description = "Proxmox bridge the build VM's NIC attaches to"
}

# ──────────────────────────────────────────────────────────────────────────────
# VM / Template identification
# ──────────────────────────────────────────────────────────────────────────────
variable "vm_id" { type = number }
variable "vm_name" {
  type    = string
  default = "win11-tiny-cloudimg"
}

# Build VM resources (throwaway install VM, not the template runtime size).
# Windows needs more headroom than the Ubuntu image.
variable "build_cores" {
  type    = number
  default = 4
}
variable "build_memory" {
  type    = number
  default = 8192
}

# ──────────────────────────────────────────────────────────────────────────────
# Install media (both expected in local:iso/ on the Proxmox node)
# ──────────────────────────────────────────────────────────────────────────────
variable "windows_iso_file" {
  type        = string
  description = "e.g. local:iso/Win11_24H2_English_x64.iso"
}
variable "windows_iso_checksum" {
  type        = string
  description = "sha256:<hex> of the Windows ISO, or \"none\" to skip"
  default     = "none"
}
variable "virtio_win_iso_file" {
  type        = string
  description = "e.g. local:iso/virtio-win.iso"
}

# ──────────────────────────────────────────────────────────────────────────────
# Build-time credentials (WinRM). Password comes from secrets.conf.
# ──────────────────────────────────────────────────────────────────────────────
variable "winrm_username" {
  type    = string
  default = "Administrator"
}
variable "winrm_password" {
  type      = string
  sensitive = true
}
variable "admin_password" {
  type        = string
  sensitive   = true
  description = "Local admin password set by Autounattend; keep == winrm_password"
}

# ──────────────────────────────────────────────────────────────────────────────
# Windows edition / licensing
# ──────────────────────────────────────────────────────────────────────────────
# Microsoft public generic Windows 11 Pro key: installs unactivated.
# Activation is per-clone HWID at first boot, not baked into the template.
variable "windows_product_key" {
  type    = string
  default = "VK7JG-NPHTM-C97JM-9MPGT-3V66T"
}

# ──────────────────────────────────────────────────────────────────────────────
# Component paths / version pins
# ──────────────────────────────────────────────────────────────────────────────
# Local path to the consumer NVIDIA (GeForce) driver installer .exe on the
# machine running Packer. "" = skip the NVIDIA step entirely.
variable "nvidia_driver_path" {
  type    = string
  default = ""
}
variable "netbird_version" {
  type    = string
  # Must match the NetBird management/relay network version. A client older than
  # the network (e.g. 0.70 vs a 0.74 network) gets half-open relay sessions:
  # peers stick at "Connecting", overlay ping/RDP/SSH all fail. Keep in lockstep.
  default = "0.74.7"
}
variable "sunshine_version" {
  type        = string
  default     = "v2026.516.143833"
  description = "Sunshine release tag; installer from LizardByte GitHub releases"
}
# Default desktop wallpaper baked into the image (users can still change it).
# Shared with the jammy image by default; "" = skip the wallpaper step.
variable "wallpaper_path" {
  type    = string
  default = "./files/wallpaper.png"
}
