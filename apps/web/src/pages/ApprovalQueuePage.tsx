import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  useSites,
  useVariantApprovals,
  useVariantDecision,
  type VariantApproval,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

/**
 * The sponsor's approval queue for site form layouts. Every entry already
 * passed data-equivalence validation at submit, so the review here is about
 * workflow suitability — not data integrity. Approving replaces the site's
 * previously approved layout.
 */
export function ApprovalQueuePage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/site-form-approvals" });
  const { data: approvals, isPending, isError, error } = useVariantApprovals(studyId);
  const { data: sites } = useSites(studyId);
  const decision = useVariantDecision(studyId);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  if (isPending) return <Spinner />;
  if (isError) return <ErrorNote>{(error as Error).message}</ErrorNote>;

  const siteName = (siteId: string) => sites?.find((s) => s.id === siteId)?.name ?? siteId;

  async function decide(approval: VariantApproval, action: "approve" | "request-changes") {
    setActionError(null);
    try {
      await decision.mutateAsync({
        versionId: approval.versionId,
        action,
        ...(notes[approval.versionId] ? { note: notes[approval.versionId] } : {}),
      });
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <div>
      <PageTitle
        sub={
          <Link to="/studies/$studyId" params={{ studyId }} className="underline">
            study
          </Link>
        }
      >
        Site layout approvals
      </PageTitle>

      {actionError ? (
        <div className="mb-4">
          <ErrorNote>{actionError}</ErrorNote>
        </div>
      ) : null}

      {(approvals ?? []).length === 0 ? (
        <Card className="p-8 text-center text-sm text-zinc-500">Nothing waiting for approval.</Card>
      ) : null}

      <div className="grid gap-4">
        {(approvals ?? []).map((approval) => (
          <Card key={approval.versionId} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-900">{approval.name}</h3>
              <Badge tone="sky">{siteName(approval.siteId)}</Badge>
              <span className="text-xs text-zinc-400">v{approval.version}</span>
              <Badge tone="emerald">data-equivalent</Badge>
              {approval.submittedAt ? (
                <span className="text-xs text-zinc-400">
                  submitted {new Date(approval.submittedAt).toLocaleString()}
                </span>
              ) : null}
            </div>

            <div className="grid gap-2 text-sm">
              {approval.definition.events.map((event) => (
                <div key={event.eventOid}>
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {event.eventOid}
                  </div>
                  {event.forms.map((form) => (
                    <div key={form.oid} className="mt-1 rounded-lg border border-zinc-200 p-2">
                      <div className="text-zinc-800">{form.name}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {form.sections.flatMap((section) =>
                          section.itemRefs.map((ref) => (
                            <span
                              key={ref.itemOid}
                              className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600"
                              title={
                                ref.displayLabel ? `relabeled: ${ref.displayLabel}` : undefined
                              }
                            >
                              {ref.itemOid}
                              {ref.displayLabel ? "*" : ""}
                            </span>
                          )),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="Decision note (optional)"
                value={notes[approval.versionId] ?? ""}
                onChange={(e) =>
                  setNotes((prev) => ({ ...prev, [approval.versionId]: e.target.value }))
                }
              />
              <Button disabled={decision.isPending} onClick={() => decide(approval, "approve")}>
                Approve
              </Button>
              <Button
                variant="secondary"
                disabled={decision.isPending}
                onClick={() => decide(approval, "request-changes")}
              >
                Request changes
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
