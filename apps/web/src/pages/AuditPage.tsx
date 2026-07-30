import { Link, useParams } from "@tanstack/react-router";
import { type AuditFilters, useAudit } from "../api/hooks.js";
import { AuditTrail } from "../components/AuditTrail.js";
import { PageTitle } from "../components/ui.js";

export function AuditPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/audit" });
  return (
    <div>
      <div className="mb-2">
        <Link
          to="/studies/$studyId"
          params={{ studyId }}
          className="text-sm text-zinc-500 hover:text-zinc-800"
        >
          ← Back to study
        </Link>
      </div>
      <PageTitle sub="Every create, change, and state transition in this study — who, when, what changed, and why. Append-only by construction.">
        Audit trail
      </PageTitle>
      <AuditTrail
        useData={(filters: AuditFilters) => useAudit(studyId, filters)}
        csvHref={(qs) => `/api/studies/${studyId}/audit?${qs}&format=csv`}
      />
    </div>
  );
}
