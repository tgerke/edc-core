#!/usr/bin/env bash
# Paired backup of the two stateful pieces (see site/deployment.qmd):
# the PostgreSQL database and the DuckLake directory. The DuckLake catalog
# lives INSIDE Postgres and references Parquet files by path — a database
# backup without the lake files from the same moment (or vice versa) is
# corrupt by construction. This script always takes both, under one
# timestamp, and must be restored as a pair.
#
# Usage:  ./backup.sh [output-dir]        (default: ./backups)
# Cron:   0 2 * * * cd /opt/edc && ./backup.sh /var/backups/edc
#
# Only meaningful with the bundled Postgres (local-db profile). With a
# managed database, use its native point-in-time recovery and snapshot the
# lake volume in the same backup window instead.
#
# Restore (fresh stack, volumes empty, api stopped):
#   docker compose -f compose.prod.yaml up -d postgres
#   gunzip -c db_<STAMP>.sql.gz | docker compose -f compose.prod.yaml exec -T postgres psql -U edc -d edc
#   docker compose -f compose.prod.yaml run --rm --no-deps --entrypoint tar api -xzf - -C /var/lib/edc < lake_<STAMP>.tar.gz
#   docker compose -f compose.prod.yaml up -d
# Then complete a restore drill: open a study and verify a published snapshot.
set -euo pipefail

cd "$(dirname "$0")"
compose="docker compose -f compose.prod.yaml"
outdir="${1:-./backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$outdir"

# Quiesce writers so both pieces reflect the same moment. Downtime is the
# price of a guaranteed-consistent pair; run in a maintenance window.
$compose stop api web >/dev/null

$compose exec -T postgres pg_dump -U edc -d edc | gzip > "$outdir/db_${stamp}.sql.gz"
$compose run --rm --no-deps --entrypoint tar api -czf - -C /var/lib/edc lake > "$outdir/lake_${stamp}.tar.gz"

$compose start api web >/dev/null

echo "backup pair written: $outdir/db_${stamp}.sql.gz + $outdir/lake_${stamp}.tar.gz"
echo "reminder: backups need the same encryption at rest as the live volumes."
