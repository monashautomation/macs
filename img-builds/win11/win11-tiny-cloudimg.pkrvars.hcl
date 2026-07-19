# ──────────────────────────────────────────────────────────────────────────────
# Proxmox connection & target
# ──────────────────────────────────────────────────────────────────────────────
proxmox_host = "https://172.22.122.10:8006/api2/json"
proxmox_node = "srv2"

# ──────────────────────────────────────────────────────────────────────────────
# VM / Template settings
# ──────────────────────────────────────────────────────────────────────────────
vm_id   = 9001
vm_name = "win11-tiny-cloudimg"

# ──────────────────────────────────────────────────────────────────────────────
# Install media (upload these to the node's local:iso/ first)
# ──────────────────────────────────────────────────────────────────────────────
windows_iso_file     = "local:iso/Win11_25H2_English_x64_v2.iso"
windows_iso_checksum = "none"
virtio_win_iso_file  = "local:iso/virtio-win.iso"

# ──────────────────────────────────────────────────────────────────────────────
# Component paths / pins
# ──────────────────────────────────────────────────────────────────────────────
# nvidia_driver_path = "573.39-desktop-win10-win11-64bit-international-dch-whql.exe"
netbird_version  = "0.74.7"
sunshine_version = "v2026.516.143833"



# No GPU on this box: skip the NVIDIA driver step.
nvidia_driver_path = ""

# Test host is 8G total; with the other test VMs cleared it can spare 6G for a
# comfortable Win11 25H2 Setup (WinPE bugcheck-loops if it can't get ~4G real).
build_cores  = 8
build_memory = 12288

