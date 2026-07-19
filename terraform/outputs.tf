output "vm_ips" {
  description = "Provisioned VM name -> IPv4 address"
  value       = { for name, m in module.vm : name => m.ipv4_address }
}
