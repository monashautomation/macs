proxmox_host = "https://172.22.122.10:8006/api2/json"
proxmox_node = "srv2"

# ──────────────────────────────────────────────────────────────────────────────
# VM / Template settings
# ──────────────────────────────────────────────────────────────────────────────
vm_id   = 9000                       # ← next free VMID on your cluster (Packer will use this)
vm_name = "golden-jam" # ← friendly name shown in Proxmox UI


# ──────────────────────────────────────────────────────────────────────────────
# Sunshine preferences
# ──────────────────────────────────────────────────────────────────────────────
sunshine_display_config = "virtual" # "default" or "virtual" (for virtual displays)

# ──────────────────────────────────────────────────────────────────────────────
# Apt mirror / proxy (optional – good for Australia)
# ──────────────────────────────────────────────────────────────────────────────
apt_mirror_url = "http://mirror.aarnet.edu.au/pub/ubuntu/archive"
# apt_cacher_url = "http://172.24.7.72:3142"

# ──────────────────────────────────────────────────────────────────────────────
# Optional component toggles
# ──────────────────────────────────────────────────────────────────────────────
install_ros     = false
cuda_version    = "12-4"
install_conda   = false
install_pytorch = false
install_vscode  = true
install_docker  = true

# ──────────────────────────────────────────────────────────────────────────────
# Optional custom wallpaper (copy from local machine running Packer)
# ──────────────────────────────────────────────────────────────────────────────
wallpaper_path = "files/wallpaper.png" # committed 8K PNG; override with any local path


# Small host (8G total): keep the build VM modest.
build_cores  = 6
build_memory = 3072


gpu_mapping       = ""

