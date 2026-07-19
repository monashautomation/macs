# variables.pkr.hcl
# ──────────────────────────────────────────────────────────────────────────────
# Proxmox connection and target
# ──────────────────────────────────────────────────────────────────────────────
variable "proxmox_host" {
  type = string
  # No default → must be provided via -var, .pkrvars.hcl, or env var
}

variable "proxmox_node" {
  type = string
}

variable "proxmox_username" {
  type = string
}

variable "proxmox_token" {
  type      = string
  sensitive = true
}

# ──────────────────────────────────────────────────────────────────────────────
# VM SSH CONNECTION
# ──────────────────────────────────────────────────────────────────────────────
variable "ssh_public_key_path" {
  type        = string
  default     = "./pkey.pem.pub"
  description = "Public half of the build SSH keypair; injected into autoinstall user-data"
}

variable "ssh_private_key_file" {
  type        = string
  default     = "./pkey.pem"
  description = "Private half of the build SSH keypair; used by the packer communicator"
}


# ──────────────────────────────────────────────────────────────────────────────
# vGPU mediated device ("" = no GPU attached, e.g. pipeline tests)
# ──────────────────────────────────────────────────────────────────────────────
variable "gpu_mapping" {
  type        = string
  default     = "NVIDIA-A16"
  description = "Proxmox PCI mapping name for the GPU; empty string disables the pci_devices block"
}

variable "gpu_mdev" {
  type        = string
  default     = "nvidia-527"
  description = "Mediated device type used when gpu_mapping is set"
}



# ──────────────────────────────────────────────────────────────────────────────
# Proxmox placement
# ──────────────────────────────────────────────────────────────────────────────
variable "pool" {
  type        = string
  default     = "packer-build"
  description = "Proxmox resource pool the build VM is created in (must exist)"
}

# ──────────────────────────────────────────────────────────────────────────────
# VM / Template identification
# ──────────────────────────────────────────────────────────────────────────────
variable "vm_id" {
  type = number
}

variable "vm_name" {
  type    = string
  default = "ubuntu-jammy-custom"
}

# Build VM resources (the throwaway VM Packer installs into, NOT the
# template's runtime size). Keep modest so the build fits on small hosts.
variable "build_cores" {
  type    = number
  default = 4
}

variable "build_memory" {
  type    = number
  default = 4096
}



# ──────────────────────────────────────────────────────────────────────────────
# Desktop environment
# ──────────────────────────────────────────────────────────────────────────────
variable "desktop_environment" {
  type        = string
  default     = "gnome"
  description = "Desktop baked into the image: \"gnome\" (ubuntu-desktop/gdm3) or \"xfce\" (xubuntu-desktop/lightdm)"

  validation {
    condition     = contains(["gnome", "xfce"], var.desktop_environment)
    error_message = "The desktop_environment value must be \"gnome\" or \"xfce\"."
  }
}

# ──────────────────────────────────────────────────────────────────────────────
# Sunshine configuration options
# ──────────────────────────────────────────────────────────────────────────────
variable "sunshine_version" {
  type        = string
  default     = "v2026.516.143833"
  description = "Sunshine release tag; deb from the LizardByte GitHub releases"
}

variable "sunshine_display_config" {
  type    = string
  default = "default" # options: "default" | "virtual"
}

# ──────────────────────────────────────────────────────────────────────────────
# Apt mirror & caching (especially useful in Australia / Melbourne)
# ──────────────────────────────────────────────────────────────────────────────
variable "apt_mirror_url" {
  type    = string
  default = "http://mirror.aarnet.edu.au/pub/ubuntu/archive"
}

variable "apt_cacher_url" {
  type    = string
  default = "" # e.g. "http://192.168.1.10:3142"
}

# When set, the cacher's CA certificate is fetched from this URL, trusted on
# the build VM, and https apt traffic is routed THROUGH the cacher (so https
# repos - Mozilla, Microsoft, Docker - are cached too). Requires the cacher to
# terminate TLS with this CA. Empty = https goes DIRECT (uncached).
variable "apt_cacher_ca_url" {
  type    = string
  default = ""
}

# ──────────────────────────────────────────────────────────────────────────────
# Optional component toggles
# ──────────────────────────────────────────────────────────────────────────────
variable "install_ros" {
  type    = bool
  default = false
}

variable "cuda_version" {
  type    = string
  default = "" # e.g. "12.4" or "12.5" to install; empty = skip
}

variable "install_conda" {
  type    = bool
  default = false
}

variable "install_pytorch" {
  type    = bool
  default = false
}

variable "install_vscode" {
  type    = bool
  default = false
}

variable "install_docker" {
  type    = bool
  default = false
}

# ──────────────────────────────────────────────────────────────────────────────
# Wallpaper (local path on the machine running Packer)
# ──────────────────────────────────────────────────────────────────────────────
variable "wallpaper_path" {
  type    = string
  default = "files/wallpaper.png"
}

