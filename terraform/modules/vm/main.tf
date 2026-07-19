locals {
  ip         = cidrhost(var.network.subnet_cidr, var.vm.vm_id)
  prefix     = split("/", var.network.subnet_cidr)[1]
  is_clone   = var.template_vm_id != null
  is_windows = local.is_clone && var.template_os == "windows"
}

# Windows clones get Cloudbase-Init PowerShell user-data; everything else gets
# cloud-init cloud-config. Note Cloudbase-Init runs no network plugin, so a
# Windows clone takes its address via DHCP — the static ip_config below is only
# honoured on the Linux paths. Access is via the NetBird overlay either way.
resource "proxmox_virtual_environment_file" "cloud_config" {
  content_type = "snippets"
  datastore_id = var.snippet_datastore
  node_name    = var.vm.node

  source_raw {
    data = local.is_windows ? templatefile("${path.module}/templates/win-user-data.ps1.tftpl", {
      name                    = var.vm.name
      vm_user                 = var.vm_user
      netbird_setup_key       = var.netbird_setup_key
      netbird_management_url  = var.netbird_management_url
      sunshine_admin_password = var.sunshine_admin_password
      }) : templatefile("${path.module}/templates/cloud-config.yaml.tftpl", {
      name                    = var.vm.name
      ip                      = local.ip
      domain                  = var.network.domain
      timezone                = var.timezone
      vm_user                 = var.vm_user
      template_user           = var.template_user
      ssh_public_key          = var.ssh_public_key
      netbird_setup_key       = var.netbird_setup_key
      netbird_management_url  = var.netbird_management_url
      is_clone                = local.is_clone
      sunshine_admin_password = var.sunshine_admin_password
      all_vms                 = var.all_vms
    })
    file_name = local.is_windows ? "${var.vm.name}-user-data.ps1" : "${var.vm.name}-cloud-config.yaml"
  }
}

resource "proxmox_virtual_environment_vm" "this" {
  name            = var.vm.name
  node_name       = var.vm.node
  vm_id           = var.vm.vm_id
  stop_on_destroy = true

  # GPU passthrough needs q35 + UEFI, and the Linux Packer templates are
  # q35/OVMF, so those clones must keep that instead of the seabios default.
  # The win11 template is the exception: q35 but SeaBIOS/MBR (OVMF can't be
  # driven unattended for the Windows ISO), so its clones must stay seabios —
  # forcing ovmf would leave the MBR disk unbootable.
  machine = local.is_clone || var.vm.gpu_pci_id != null ? "q35" : null
  bios    = local.is_windows ? "seabios" : (local.is_clone || var.vm.gpu_pci_id != null ? "ovmf" : "seabios")

  agent {
    enabled = true
  }

  cpu {
    architecture = "x86_64"
    cores        = var.vm.cores
    type         = var.vm.cpu_type
  }

  memory {
    dedicated = var.vm.memory_mb
  }

  dynamic "clone" {
    for_each = local.is_clone ? [1] : []
    content {
      vm_id = var.template_vm_id
      full  = true
    }
  }

  # Packer templates attach their disk as scsi0; cloud images use virtio0.
  disk {
    datastore_id = var.vm.datastore
    file_id      = local.is_clone ? null : var.image_file_id
    interface    = local.is_clone ? "scsi0" : "virtio0"
    iothread     = true
    discard      = "on"
    size         = var.vm.disk_gb
  }

  # Golden-image clones stream via Sunshine's KMS capture, which needs a
  # KMS-capable display device: virtio-gpu exposes /dev/dri in the guest so
  # compositors and kmsgrab work. Windows is excluded: its Sunshine captures
  # via DXGI on any adapter, and the win11 template was built and
  # smoke-tested on the default std VGA.
  dynamic "vga" {
    for_each = local.is_clone && !local.is_windows ? [1] : []
    content {
      type   = "virtio"
      memory = 32
    }
  }

  # Clones inherit the template's EFI disk; only the cloud-image GPU path
  # needs one created here.
  dynamic "efi_disk" {
    for_each = var.vm.gpu_pci_id != null && !local.is_clone ? [1] : []
    content {
      datastore_id = var.vm.datastore
      type         = "4m"
    }
  }

  dynamic "hostpci" {
    for_each = var.vm.gpu_pci_id != null ? [1] : []
    content {
      device = "hostpci0"
      id     = var.vm.gpu_pci_id
      pcie   = true
    }
  }

  network_device {
    bridge  = var.network.bridge
    vlan_id = var.network.vlan_id
  }

  initialization {
    datastore_id      = var.vm.datastore
    user_data_file_id = proxmox_virtual_environment_file.cloud_config.id

    dns {
      servers = var.network.upstream_dns
      domain  = var.network.domain
    }

    ip_config {
      ipv4 {
        address = "${local.ip}/${local.prefix}"
        gateway = var.network.gateway
      }
    }
  }
}
