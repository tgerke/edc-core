# edc-core on AWS (single VM)

Provisions one EC2 instance running the production stack
(`infra/compose.prod.yaml`) via `infra/cloud-init.yaml` — Terraform never
duplicates install logic (ADR-0011). Same variable contract as the
`../azure` and `../digitalocean` roots.

```sh
terraform init
terraform apply \
  -var ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)" \
  -var admin_cidr="203.0.113.7/32" \
  -var domain="edc.example.org" \
  -var app_version="0.4.0"
```

Then point the domain's A record at the `public_ip` output; Caddy obtains
the TLS certificate on its own. Watch first boot with
`ssh ubuntu@<ip> cloud-init status --wait`, and create the first admin:

```sh
ssh ubuntu@<ip> "cd /opt/edc && sudo docker compose -f compose.prod.yaml exec api pnpm --filter @edc-core/api db:bootstrap-admin"
```

What you get: Ubuntu 24.04 on `t3a.medium` in the default VPC, an encrypted
gp3 root volume (Postgres + DuckLake data), a security group exposing only
80/443 (SSH restricted to `admin_cidr`), and an Elastic IP.

**One API instance, always** — the notification scheduler runs in-process
and assumes it. Scale up (`instance_size`), never out.

Managed Postgres instead of the bundled one: create the RDS instance
yourself (PostgreSQL 16+, TLS required), then set
`-var compose_profiles="engines"` and pass the connection string via
`-var extra_env="DATABASE_URL=postgres://...sslmode=verify-full"`.

State is local (`terraform.tfstate` — it contains the generated database
password; treat it as a secret). For team use, add one of the standard
remote backends in `versions.tf`.

Remaining operational work — encrypted backups on a retention schedule,
restore drills, log retention — is the
[deployment guide](https://tgerke.github.io/edc-core/deployment.html).
