check "templates_resolvable" {
  assert {
    condition     = alltrue([for vm in var.vms : vm.template == null || contains(keys(var.templates), coalesce(vm.template, "-"))])
    error_message = "Every vm.template must be a key of var.templates."
  }
}

locals {
  # Storage pool fallbacks: anything unset uses default_datastore.
  image_datastore   = coalesce(var.image_datastore, var.default_datastore)
  snippet_datastore = coalesce(var.snippet_datastore, var.default_datastore)

  # Resolve per-VM datastore before handing VMs to the module.
  vms = [
    for vm in var.vms : merge(vm, {
      datastore = coalesce(vm.datastore, var.default_datastore)
    })
  ]

  # Cloud image is only needed on nodes with at least one non-template VM.
  vm_nodes = toset([for vm in var.vms : vm.node if vm.template == null])

  all_vms = [
    for vm in var.vms : {
      name = vm.name
      ip   = cidrhost(var.network.subnet_cidr, vm.vm_id)
    }
  ]
}

resource "proxmox_virtual_environment_download_file" "ubuntu_cloud_image" {
  for_each = local.vm_nodes

  content_type   = "iso"
  datastore_id   = local.image_datastore
  node_name      = each.value
  upload_timeout = 2500
  file_name      = "ubuntu-22.04-server-cloudimg-amd64.img"
  url            = "https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-amd64.img"
}

module "vm" {
  source   = "./modules/vm"
  for_each = { for vm in local.vms : vm.name => vm }

  vm                      = each.value
  network                 = var.network
  image_file_id           = each.value.template == null ? proxmox_virtual_environment_download_file.ubuntu_cloud_image[each.value.node].id : null
  template_vm_id          = each.value.template != null ? var.templates[each.value.template].vm_id : null
  template_os             = each.value.template != null ? var.templates[each.value.template].os : "linux"
  template_user           = var.template_user
  snippet_datastore       = local.snippet_datastore
  vm_user                 = var.vm_user
  ssh_public_key          = trimspace(file(var.ssh_public_key_path))
  timezone                = var.timezone
  netbird_setup_key       = var.netbird_setup_key
  netbird_management_url  = var.netbird_management_url
  sunshine_admin_password = var.sunshine_admin_password
  all_vms                 = local.all_vms
}
