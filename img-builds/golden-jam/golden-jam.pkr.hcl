packer {
  required_plugins {
    proxmox = {
      version = ">= 1.1.0"
      source  = "github.com/hashicorp/proxmox"
    }
  }
}

source "proxmox-iso" "ubuntu-golden-jam-cloudimg" {
  proxmox_url              = var.proxmox_host
  insecure_skip_tls_verify = true
  username                 = var.proxmox_username
  token                    = var.proxmox_token

  node = var.proxmox_node
  pool = var.pool

  vm_id                = var.vm_id
  vm_name              = var.vm_name
  template_description = "Ubuntu 22.04 Jammy virtual workstation (cloud-init enabled)"
  bios                 = "ovmf"
  machine              = "q35"
  qemu_agent           = true

  efi_config {
    efi_storage_pool = "pmoxpool01"
    efi_type         = "4m"
  }

  cores  = var.build_cores
  memory = var.build_memory

  boot_iso {
    type         = "ide"
    iso_file     = "local:iso/ubuntu-22.04.5-live-server-amd64.iso"
    iso_checksum = "sha256 9bc6028870aef3f74f4e16b900008179e78b130e6b0b9a140635434a46aa98b0"
    unmount      = true
  }

  scsi_controller = "virtio-scsi-single"

  additional_iso_files {
    cd_content = {
      "user-data" = templatefile("${path.root}/templates/user-data.pkrtpl.hcl", {
        ssh_public_key = trimspace(file(var.ssh_public_key_path))
        apt_mirror_url = var.apt_mirror_url
        apt_cacher_url = var.apt_cacher_url
      })
      "meta-data" = ""
    }
    cd_label         = "cidata"
    iso_storage_pool = "local"
    unmount          = true
    type             = "ide"
    index            = "1"
  }

  boot_wait = "10s"
  boot_command = [
    "<esc><wait>",
    "e<wait>",
    "<down><down><down><end>",
    " autoinstall quiet ds=nocloud",
    "<f10><wait>",
    "<wait10m>"
  ]

  communicator           = "ssh"
  ssh_username           = "baker"
  ssh_private_key_file   = var.ssh_private_key_file
  ssh_timeout            = "60m"
  ssh_handshake_attempts = "2048"

  cloud_init              = true
  cloud_init_storage_pool = "pmoxpool01"

  serials = ["socket"]

  disks {
    disk_size    = "64G"
    storage_pool = "pmoxpool01"
    discard      = true
    ssd          = true
    type         = "scsi"
    io_thread    = true
  }

  network_adapters {
    bridge = "vmbr0"
    model  = "virtio"
  }

  dynamic "pci_devices" {
    for_each = var.gpu_mapping != "" ? [1] : []
    content {
      mapping = var.gpu_mapping
      pcie    = true
      mdev    = var.gpu_mdev
      x_vga   = false
    }
  }
}

build {
  sources = ["source.proxmox-iso.ubuntu-golden-jam-cloudimg"]

  provisioner "shell" {
    environment_vars = [
      "APT_CACHER_URL=${var.apt_cacher_url}",
      "APT_CACHER_CA_URL=${var.apt_cacher_ca_url}",
    ]
    inline = [
      "while [ ! -f /var/lib/cloud/instance/boot-finished ]; do echo 'Waiting for cloud-init...'; sleep 1; done",
      "sudo mkdir -p /usr/local/packer",
      "sudo chown --recursive baker /usr/local/packer",
      # http apt always goes through the cacher. https: if a cacher CA is
      # given, trust it and route https through the cacher too (cached);
      # otherwise send https DIRECT, because apt-cacher-ng can't tunnel https
      # CONNECT and would 403 the Microsoft/Docker/Mozilla repos. The file is
      # named 99- so it loads AFTER subiquity's 90curtin-aptproxy and wins.
      "if [ -n \"$APT_CACHER_URL\" ]; then if [ -n \"$APT_CACHER_CA_URL\" ]; then curl -fsSL \"$APT_CACHER_CA_URL\" | sudo tee /usr/local/share/ca-certificates/apt-cacher-ng.crt >/dev/null && sudo update-ca-certificates && printf 'Acquire::http::Proxy \"%s\";\\nAcquire::https::Proxy \"%s\";\\n' \"$APT_CACHER_URL\" \"$APT_CACHER_URL\" | sudo tee /etc/apt/apt.conf.d/99-packer-proxy; else printf 'Acquire::http::Proxy \"%s\";\\nAcquire::https::Proxy \"DIRECT\";\\n' \"$APT_CACHER_URL\" | sudo tee /etc/apt/apt.conf.d/99-packer-proxy; fi; fi",
    ]
  }

  provisioner "file" {
    source      = var.wallpaper_path
    destination = "/usr/local/packer/wallpaper.png"
  }

  provisioner "shell" {
    scripts          = ["scripts/01-install-desktop.sh"]
    environment_vars = ["DESKTOP_ENV=${var.desktop_environment}"]
  }
  provisioner "shell" { scripts = ["scripts/02-disable-ssh-password.sh"] }
  #provisioner "shell" { scripts = ["scripts/03-install-nvidia-grid.sh"] }
  provisioner "shell" {
    scripts          = ["scripts/04-install-sunshine.sh"]
    environment_vars = ["SUNSHINE_VERSION=${var.sunshine_version}"]
  }
  provisioner "shell" { scripts = ["scripts/05-sunshine-pairing-script.sh"] }
  #provisioner "shell" { scripts = ["scripts/06-install-nvlts.sh"] }

  provisioner "shell" {
    scripts          = ["scripts/07-optional-ros2.sh"]
    environment_vars = ["INSTALL_ROS=${var.install_ros}"]
  }

  provisioner "shell" {
    scripts          = ["scripts/08-optional-cuda.sh"]
    environment_vars = ["CUDA_VERSION=${var.cuda_version}"]
  }

  provisioner "shell" {
    scripts = ["scripts/09-optional-conda-pytorch-vscode.sh"]
    environment_vars = [
      "INSTALL_CONDA=${var.install_conda}",
      "INSTALL_PYTORCH=${var.install_pytorch}",
      "INSTALL_VSCODE=${var.install_vscode}",
    ]
  }

  provisioner "shell" {
    scripts          = ["scripts/10-optional-docker.sh"]
    environment_vars = ["INSTALL_DOCKER=${var.install_docker}"]
  }

  provisioner "shell" {
    scripts          = ["scripts/11-gnome-defaults.sh"]
    environment_vars = ["DESKTOP_ENV=${var.desktop_environment}"]
  }

  provisioner "shell" {
    scripts          = ["scripts/12-wallpaper.sh"]
    environment_vars = ["DESKTOP_ENV=${var.desktop_environment}"]
  }

  provisioner "shell" {
    scripts = ["scripts/13-cloud-init-customizations.sh"]
    environment_vars = [
      "SUNSHINE_DISPLAY_CONFIG=${var.sunshine_display_config}",
      "DESKTOP_ENV=${var.desktop_environment}",
    ]
  }

  # provisioner "shell" {
  #   inline = [
  #     # Don't bake the build-time apt proxy or the cacher CA into the template.
  #     "sudo rm -f /etc/apt/apt.conf.d/99-packer-proxy /etc/apt/apt.conf.d/90curtin-aptproxy",
  #     "sudo rm -f /usr/local/share/ca-certificates/apt-cacher-ng.crt && sudo update-ca-certificates --fresh >/dev/null 2>&1 || true",
  #     "sudo chown --recursive root /usr/local/packer",
  #     "sudo cloud-init clean",
  #   ]
  # }
}

