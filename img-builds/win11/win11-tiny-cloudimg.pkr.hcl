packer {
  required_plugins {
    proxmox = {
      version = ">= 1.1.0"
      source  = "github.com/hashicorp/proxmox"
    }
  }
}

source "proxmox-iso" "win11-tiny-cloudimg" {
  proxmox_url              = var.proxmox_host
  insecure_skip_tls_verify = true
  username                 = var.proxmox_username
  token                    = var.proxmox_token

  node = var.proxmox_node
  pool = var.pool

  vm_id               = var.vm_id
  vm_name             = var.vm_name
  template_description = "Windows 11 Pro debloated workstation (Cloudbase-Init enabled)"
  # SeaBIOS (legacy BIOS/MBR), NOT OVMF/UEFI. Under OVMF the Windows ISO's
  # "Press any key to boot from CD" prompt only accepts a real interactive
  # keypress - synthetic keys (Packer boot_command, qm sendkey) never register,
  # so Setup can't be started unattended. SeaBIOS's prompt is a legacy BIOS
  # keyboard read that boot_command DOES satisfy. The installed template
  # therefore boots BIOS/MBR (no Secure Boot / GPT, not needed here).
  bios                = "seabios"
  machine             = "q35"
  qemu_agent          = true
  os                  = "win11"
  # Windows 11 requires CPU features the Proxmox default "kvm64" model does not
  # expose (POPCNT, SSE4.2, ...); without them WinPE bugcheck-loops at the boot
  # logo. "host" passes the node's CPU through. For clones that must migrate
  # across mixed CPUs, switch to a portable model like x86-64-v2-AES.
  cpu_type            = "host"

  cores  = var.build_cores
  memory = var.build_memory

  boot_iso {
    type         = "ide"
    iso_file     = var.windows_iso_file
    iso_checksum = var.windows_iso_checksum
    unmount      = true
  }

  # Autounattend answer file + WinRM bootstrap on a virtual CD (drive A:).
  additional_iso_files {
    cd_content = {
      "Autounattend.xml" = templatefile("${path.root}/templates/Autounattend.pkrtpl.hcl", {
        admin_password      = var.admin_password
        winrm_username      = var.winrm_username
        windows_product_key = var.windows_product_key
      })
      "bootstrap-winrm.ps1" = file("${path.root}/scripts/bootstrap-winrm.ps1")
    }
    cd_label         = "cidata"
    iso_storage_pool = "local"
    unmount          = true
    type             = "ide"
    index            = "1"
  }

  # virtio-win drivers so Setup can see the virtio SCSI disk + NIC (drive E:).
  additional_iso_files {
    iso_file = var.virtio_win_iso_file
    type     = "ide"
    index    = "2"
    unmount  = true
  }

  scsi_controller = "virtio-scsi-single"

  disks {
    disk_size    = "64G"
    storage_pool = "pmoxpool01"
    discard      = true
    ssd          = true
    type         = "scsi"
    io_thread    = true
  }

  network_adapters {
    bridge = var.network_bridge
    model  = "virtio"
  }

  # Boot order is disk-FIRST: on the first boot scsi0 is empty so SeaBIOS falls
  # through to the CD (ide0); on Setup's reboots scsi0 holds the Windows boot
  # loader and boots the installed system (the CD's "press any key" prompt is
  # left unanswered on reboots and times out).
  boot = "order=scsi0;ide0;net0"

  # Two-phase boot_command:
  #  1. SeaBIOS shows "Press any key to boot from CD or DVD" (~5s). Unlike OVMF,
  #     this legacy BIOS prompt accepts synthetic keys, so hammer Enter for ~10s
  #     to start Setup.
  #  2. The redesigned Windows 11 25H2 setup reads the CD Autounattend only AFTER
  #     its new "Select language" + "Select keyboard" screens, so the answer file
  #     cannot suppress them. Wait for WinPE, then send Alt+N (the "Next"
  #     accelerator) repeatedly across a wide window to click through both screens
  #     regardless of load speed. Once install begins there is no "Next" button so
  #     the extra presses are inert; the Autounattend then drives edition, EULA,
  #     partitioning, install and OOBE unattended.
  boot_wait    = "3s"
  boot_command = [
    "<enter><wait><enter><wait><enter><wait><enter><wait><enter><wait><enter><wait><enter><wait><enter><wait><enter><wait><enter>",
    "<wait45>",
    "<leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff><wait6><leftAltOn>n<leftAltOff>"
  ]

  communicator   = "winrm"
  winrm_username = var.winrm_username
  winrm_password = var.winrm_password
  winrm_timeout  = "60m"
  winrm_use_ssl  = false
  winrm_insecure = true
}

build {
  sources = ["source.proxmox-iso.win11-tiny-cloudimg"]

  provisioner "powershell" { scripts = ["scripts/01-debloat.ps1"] }
  provisioner "powershell" { scripts = ["scripts/02-virtio-guest-tools.ps1"] }

  provisioner "powershell" {
    inline = ["New-Item -ItemType Directory -Force -Path C:\\packer | Out-Null"]
  }

  # Consumer NVIDIA installer (local file). Empty sources when
  # nvidia_driver_path = "" -> nothing uploaded and 03 skips itself.
  provisioner "file" {
    sources     = var.nvidia_driver_path != "" ? [var.nvidia_driver_path] : []
    destination = "C:\\packer\\nvidia.exe"
  }

  provisioner "powershell" { scripts = ["scripts/03-nvidia-driver.ps1"] }

  provisioner "powershell" {
    scripts          = ["scripts/04-netbird.ps1"]
    environment_vars = ["NETBIRD_VERSION=${var.netbird_version}"]
  }

  provisioner "powershell" {
    scripts          = ["scripts/05-sunshine.ps1"]
    environment_vars = ["SUNSHINE_VERSION=${var.sunshine_version}"]
  }

  provisioner "powershell" { scripts = ["scripts/06-rdp.ps1"] }

  provisioner "file" {
    source      = "scripts/files/cloudbase-init.conf"
    destination = "C:\\packer\\cloudbase-init.conf"
  }
  provisioner "file" {
    source      = "scripts/files/cloudbase-init-unattend.conf"
    destination = "C:\\packer\\cloudbase-init-unattend.conf"
  }
  provisioner "powershell" { scripts = ["scripts/07-cloudbase-init.ps1"] }

  provisioner "file" {
    source      = "scripts/files/activate-hwid.ps1"
    destination = "C:\\packer\\activate-hwid.ps1"
  }
  provisioner "file" {
    source      = "scripts/files/netbird-join.ps1"
    destination = "C:\\packer\\netbird-join.ps1"
  }
  provisioner "file" {
    source      = "scripts/files/remote-allow.ps1"
    destination = "C:\\packer\\remote-allow.ps1"
  }
  provisioner "file" {
    source      = "scripts/files/sunshine-config.ps1"
    destination = "C:\\packer\\sunshine-config.ps1"
  }
  provisioner "file" {
    source      = "scripts/files/sunshine-pair.ps1"
    destination = "C:\\packer\\sunshine-pair.ps1"
  }
  provisioner "powershell" { scripts = ["scripts/08-first-boot-tasks.ps1"] }

  # Default desktop wallpaper (shared with the jammy image). Empty sources
  # when wallpaper_path = "" -> nothing uploaded and 09 skips itself.
  provisioner "file" {
    sources     = var.wallpaper_path != "" ? [var.wallpaper_path] : []
    destination = "C:\\packer\\wallpaper.png"
  }
  provisioner "powershell" { scripts = ["scripts/09-wallpaper.ps1"] }

  provisioner "file" {
    source      = "templates/sysprep-unattend.xml"
    destination = "C:\\packer\\sysprep-unattend.xml"
  }

  provisioner "powershell" {
    inline = [
      # Re-enable Windows Update for clones (disabled during build in 01).
      "Set-Service -Name wuauserv -StartupType Manual",
      # Remove the build-time WinRM firewall exception; clones don't need it.
      "Remove-NetFirewallRule -Name 'WinRM-HTTP-In-Build' -ErrorAction SilentlyContinue",
      # Wipe NetBird state so each clone starts from a clean profile: the
      # service scaffolds ProgramData files on first start, and baking them
      # makes the service attempt (and log-spam) an unauthenticated login on
      # every clone boot before the user-data join runs.
      "Stop-Service netbird -Force -ErrorAction SilentlyContinue",
      "Remove-Item -Recurse -Force 'C:\\ProgramData\\netbird\\*' -ErrorAction SilentlyContinue",
      # Generalize + shutdown. Cloudbase-Init's unattend runs its specialize
      # hook on the clone; our OOBE unattend keeps OOBE suppressed. (if/else,
      # not a ternary: the build VM runs Windows PowerShell 5.1.)
      "$cb = 'C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\conf\\Unattend.xml'",
      "if (Test-Path $cb) { $unattend = $cb } else { $unattend = 'C:\\packer\\sysprep-unattend.xml' }",
      "Write-Host \"Sysprep generalize using $unattend\"",
      "Start-Process -FilePath \"$env:windir\\System32\\Sysprep\\sysprep.exe\" -ArgumentList \"/generalize /oobe /shutdown /quiet /unattend:$unattend\" -Wait"
    ]
  }
}
