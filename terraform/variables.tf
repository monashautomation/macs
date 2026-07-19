variable "proxmox_endpoint" {
  description = "Proxmox API URL, e.g. https://host:8006"
  type        = string
}

variable "proxmox_user_name" {
  description = "Proxmox user or API token id"
  type        = string
}

variable "proxmox_user_password" {
  description = "Proxmox password or API token secret"
  type        = string
  sensitive   = true
}

variable "vm_user" {
  description = "Linux username created on every VM"
  type        = string
  default     = "baker"
}

variable "ssh_public_key_path" {
  description = "Path to the SSH public key installed on every VM"
  type        = string
  default     = "./id_rsa.pub"
}

variable "timezone" {
  description = "Timezone set on every VM"
  type        = string
  default     = "Australia/Melbourne"
}

variable "netbird_setup_key" {
  description = "Netbird setup key used to enroll every VM"
  type        = string
  sensitive   = true
}

variable "netbird_management_url" {
  description = "Self-hosted Netbird management server URL; empty = Netbird SaaS"
  type        = string
  default     = ""
}

variable "template_user" {
  description = "Default user baked into the Linux golden image (see img-builds/golden-jam)"
  type        = string
  default     = "baker"
}

variable "sunshine_admin_password" {
  description = "Web UI credential set at provision time (user = vm_user); empty = leave first-run setup"
  type        = string
  sensitive   = true
  default     = ""
}

variable "default_datastore" {
  description = "Default storage pool for VM disks, cloud images, and snippets when not overridden"
  type        = string
  default     = "local"
}

variable "image_datastore" {
  description = "Datastore (per node) for the Ubuntu cloud image; null = default_datastore"
  type        = string
  default     = null
}

variable "snippet_datastore" {
  description = "Datastore (per node) for cloud-init snippets (must allow snippets content); null = default_datastore"
  type        = string
  default     = null
}

variable "network" {
  description = "Shared network settings for all VMs"
  type = object({
    bridge       = optional(string, "vmbr1")
    vlan_id      = optional(number, "60")
    subnet_cidr  = string
    gateway      = string
    upstream_dns = list(string)
    domain       = optional(string, null) # null = no FQDN / DNS search domain
  })
}

variable "vms" {
  description = "VMs to provision. IP = cidrhost(network.subnet_cidr, vm_id)."
  type = list(object({
    name       = string
    node       = string
    vm_id      = number
    cores      = number
    cpu_type   = optional(string, "x86-64-v3") # "host" = max perf, no live migration
    memory_mb  = number
    disk_gb    = number
    datastore  = optional(string, null) # null = default_datastore
    gpu_pci_id = optional(string, null)
    template   = optional(string, null) # key into var.templates; null = plain cloud-image VM
  }))

  validation {
    condition     = length(distinct([for vm in var.vms : vm.vm_id])) == length(var.vms)
    error_message = "vm_id values must be unique."
  }

  validation {
    condition     = length(distinct([for vm in var.vms : vm.name])) == length(var.vms)
    error_message = "vm names must be unique."
  }
}

variable "templates" {
  description = "Packer-built golden-image templates (built from img-builds/) available for cloning: name -> { vm_id, os }"
  type = map(object({
    vm_id = number
    os    = optional(string, "linux") # "linux" | "windows" — picks the user-data flavour and firmware
  }))
  default = {}

  validation {
    condition     = alltrue([for t in var.templates : contains(["linux", "windows"], t.os)])
    error_message = "template os must be \"linux\" or \"windows\"."
  }
}
