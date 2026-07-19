variable "vm" {
  description = "One VM definition from the root vms list"
  type = object({
    name       = string
    node       = string
    vm_id      = number
    cores      = number
    cpu_type   = optional(string, "x86-64-v3") # "host" = max perf, no live migration
    memory_mb  = number
    disk_gb    = number
    datastore  = optional(string, "local")
    gpu_pci_id = optional(string, null)
    template   = optional(string, null)
  })
}

variable "network" {
  type = object({
    bridge       = optional(string, "vmbr1")
    vlan_id      = optional(number, null)
    subnet_cidr  = string
    gateway      = string
    upstream_dns = list(string)
    domain       = optional(string, null) # null = no FQDN / DNS search domain
  })
}

variable "image_file_id" {
  description = "Proxmox file id of the Ubuntu cloud image on this VM's node; null when cloning a template"
  type        = string
  default     = null
}

variable "template_vm_id" {
  description = "vm_id of the Packer-built template to full-clone; null = cloud-image path"
  type        = number
  default     = null
}

variable "template_os" {
  description = "OS family of the cloned template (\"linux\" or \"windows\"); ignored on the cloud-image path"
  type        = string
  default     = "linux"

  validation {
    condition     = contains(["linux", "windows"], var.template_os)
    error_message = "template_os must be \"linux\" or \"windows\"."
  }
}

variable "template_user" {
  description = "Default user baked into the Linux golden image (see img-builds/golden-jam)"
  type        = string
  default     = "baker"
}

variable "snippet_datastore" {
  type = string
}

variable "vm_user" {
  type = string
}

variable "ssh_public_key" {
  description = "SSH public key content"
  type        = string
}

variable "timezone" {
  type = string
}

variable "netbird_setup_key" {
  type      = string
  sensitive = true
}

variable "netbird_management_url" {
  description = "Self-hosted Netbird management server URL; empty = Netbird SaaS"
  type        = string
  default     = ""
}

variable "sunshine_admin_password" {
  type      = string
  sensitive = true
  default   = ""
}

variable "all_vms" {
  description = "All VMs (name + ip) for /etc/hosts generation"
  type = list(object({
    name = string
    ip   = string
  }))
}
