-- Local development only; runs once, on first boot of a fresh pgdata volume.
-- Migration 0024 grants this role its privileges. Production deployments
-- create the runtime role themselves with a real password before the first
-- migration (see the deployment guide).
CREATE ROLE edc_app LOGIN PASSWORD 'edc-dev-only';
