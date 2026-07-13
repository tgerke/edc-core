output "public_ip" {
  description = "Static address to point the domain's A record at"
  value       = azurerm_public_ip.host.ip_address
}

output "ssh_command" {
  value = "ssh ubuntu@${azurerm_public_ip.host.ip_address}"
}

output "dns_instructions" {
  value = "Create an A record: ${var.domain} -> ${azurerm_public_ip.host.ip_address}. Caddy obtains TLS automatically once it resolves."
}
