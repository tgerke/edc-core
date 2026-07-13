# One VM running infra/compose.prod.yaml (ADR-0011). All app installation is
# delegated to infra/cloud-init.yaml — this root only provisions the machine,
# its firewall, and a stable address.
#
# The API must run as exactly one instance (in-process scheduler); scale up,
# never out.

provider "aws" {
  region = var.region
}

data "aws_vpc" "default" {
  default = true
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "aws_key_pair" "admin" {
  key_name   = "${var.name}-admin"
  public_key = var.ssh_public_key
  tags       = var.tags
}

resource "aws_security_group" "host" {
  name        = var.name
  description = "edc-core single-VM stack: SSH from admin_cidr, HTTPS from anywhere"
  vpc_id      = data.aws_vpc.default.id
  tags        = var.tags

  ingress {
    description = "SSH (admin only)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "HTTP (Caddy redirects to HTTPS and answers ACME)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS (HTTP/3)"
    from_port   = 443
    to_port     = 443
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "host" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_size
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.host.id]
  tags                   = merge(var.tags, { Name = var.name })

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true # pgdata, lakedata, and backups live here
  }

  user_data = templatefile("${path.module}/../../cloud-init.yaml", {
    domain            = var.domain
    app_version       = var.app_version
    postgres_password = random_password.postgres.result
    compose_profiles  = var.compose_profiles
    extra_env         = indent(6, var.extra_env)
  })
}

resource "aws_eip" "host" {
  instance = aws_instance.host.id
  domain   = "vpc"
  tags     = var.tags
}
