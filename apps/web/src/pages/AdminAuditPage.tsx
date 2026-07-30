import { AuditTrail } from "../components/AuditTrail.js";
import { PageTitle } from "../components/ui.js";

export function AdminAuditPage() {
  return (
    <div>
      <PageTitle sub="Events recorded outside any study — logins and lockouts, account lifecycle, system-administration changes. Same append-only trail, system-administration scope.">
        System audit trail
      </PageTitle>
      <AuditTrail studyId={null} />
    </div>
  );
}
