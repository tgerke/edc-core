-- Append-only enforcement (ADR-0002; traceability P11-01, E6-03).
--
-- History must be a structural property of the database, not an application
-- convention: these triggers reject UPDATE and DELETE regardless of which
-- code path (or human with psql) attempts them. The application role must
-- never own these tables or hold TRIGGER privilege on them.

CREATE FUNCTION edc_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: table is append-only (21 CFR Part 11 audit trail)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION edc_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER item_value_versions_append_only
  BEFORE UPDATE OR DELETE ON item_value_versions
  FOR EACH ROW EXECUTE FUNCTION edc_reject_mutation();
--> statement-breakpoint

-- Signatures may be invalidated (a one-way transition setting invalidated_at /
-- invalidated_reason on a live signature) but never deleted or otherwise
-- altered (P11-10: signatures cannot be excised or transferred).
CREATE FUNCTION edc_signature_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on signatures is not permitted (21 CFR 11.70)'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.form_instance_id IS DISTINCT FROM OLD.form_instance_id
     OR NEW.signer_id IS DISTINCT FROM OLD.signer_id
     OR NEW.meaning IS DISTINCT FROM OLD.meaning
     OR NEW.record_hash IS DISTINCT FROM OLD.record_hash
     OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
     OR OLD.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION 'signatures are immutable; only invalidation of a live signature is permitted (21 CFR 11.70)'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER signatures_guard
  BEFORE UPDATE OR DELETE ON signatures
  FOR EACH ROW EXECUTE FUNCTION edc_signature_guard();
--> statement-breakpoint

-- Current values: latest version per (form instance, item group, repeat, item).
CREATE VIEW item_values_current AS
SELECT DISTINCT ON (form_instance_id, item_group_oid, item_group_repeat_key, item_oid)
  id, form_instance_id, item_group_oid, item_group_repeat_key, item_oid,
  version, value, reason_for_change, created_by, created_at
FROM item_value_versions
ORDER BY form_instance_id, item_group_oid, item_group_repeat_key, item_oid, version DESC;
