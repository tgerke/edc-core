# The same variable contract as ../azure and ../digitalocean (ADR-0011).

variable "name" {
  description = "Resource name prefix"
  type        = string
  default     = "edc-core"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_size" {
  description = "EC2 instance type (2 vCPU / 4 GB is comfortable for the full stack)"
  type        = string
  default     = "t3a.medium"
}

variable "ssh_public_key" {
  description = "SSH public key material for the admin user"
  type        = string
}

variable "admin_cidr" {
  description = "CIDR allowed to reach SSH (e.g. your office or VPN range — never 0.0.0.0/0)"
  type        = string
}

variable "domain" {
  description = "Hostname the stack serves; point its DNS A record at the public_ip output"
  type        = string
}

variable "app_version" {
  description = "Released edc-core version to run (git tag without the leading v)"
  type        = string
}

variable "root_volume_gb" {
  description = "Root disk size in GB (holds Postgres and the DuckLake volumes); always encrypted"
  type        = number
  default     = 50
}

variable "compose_profiles" {
  description = "COMPOSE_PROFILES for the stack: local-db = bundled Postgres, engines = analytics sidecars"
  type        = string
  default     = "local-db,engines"
}

variable "extra_env" {
  description = "Additional .env lines (managed DATABASE_URL, OIDC, SMTP — see infra/.env.example), newline-separated"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to every resource"
  type        = map(string)
  default     = {}
}
