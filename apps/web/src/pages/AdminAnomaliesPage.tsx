import { useState } from "react";
import {
  type AnomalyFilters,
  anomalyQueryString,
  type SecurityAnomaly,
  useAcknowledgeAnomaly,
  useSecurityAnomalies,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

const PAGE_SIZE = 50;

const KIND_LABELS: Record<SecurityAnomaly["kind"], string> = {
  failed_login_burst: "Failed-login burst",
  lockout: "Lockout",
  session_binding_violation: "Session binding violation",
};

function AcknowledgeControl({ anomaly }: { anomaly: SecurityAnomaly }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const acknowledge = useAcknowledgeAnomaly();

  if (anomaly.acknowledgedAt) {
    return (
      <div className="text-xs text-zinc-500">
        <div>
          Acknowledged by <span className="font-medium">{anomaly.acknowledgedBy}</span>{" "}
          {new Date(anomaly.acknowledgedAt).toLocaleString()}
        </div>
        {anomaly.acknowledgedNote ? (
          <div className="mt-0.5 text-zinc-400">{anomaly.acknowledgedNote}</div>
        ) : null}
      </div>
    );
  }

  if (!editing) {
    return (
      <Button variant="secondary" onClick={() => setEditing(true)}>
        Acknowledge
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="w-56">
        <Input
          placeholder="Note (optional)…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <Button
        disabled={acknowledge.isPending}
        onClick={() =>
          acknowledge.mutate(
            { anomalyId: anomaly.id, ...(note.trim() ? { note: note.trim() } : {}) },
            { onSuccess: () => setEditing(false) },
          )
        }
      >
        Confirm
      </Button>
      <Button variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  );
}

export function AdminAnomaliesPage() {
  const [status, setStatus] = useState<"open" | "acknowledged" | "">("open");
  const [offset, setOffset] = useState(0);

  const filters: AnomalyFilters = {
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    offset,
  };
  const { data, isPending, isError } = useSecurityAnomalies(filters);

  if (isPending) return <Spinner />;
  if (isError || !data) return <ErrorNote>Failed to load security anomalies.</ErrorNote>;

  return (
    <div>
      <PageTitle sub="Findings from the periodic sweep over the access log and audit trail — failed-login bursts, lockouts, and session binding violations. Acknowledging one records the response in the audit trail.">
        Security anomalies
      </PageTitle>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["open", "acknowledged", ""] as const).map((option) => (
          <Button
            key={option || "all"}
            variant={status === option ? "primary" : "ghost"}
            onClick={() => {
              setStatus(option);
              setOffset(0);
            }}
          >
            {option === "" ? "All" : option === "open" ? "Open" : "Acknowledged"}
          </Button>
        ))}
        <a
          className="ml-auto inline-flex items-center rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-zinc-800 ring-1 ring-zinc-200 hover:bg-zinc-50"
          href={`/api/admin/security-anomalies?${anomalyQueryString(filters)}&format=csv`}
        >
          Export CSV
        </a>
      </div>

      <Card>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
              <th className="px-4 py-3 font-medium">Detected</th>
              <th className="px-4 py-3 font-medium">Kind</th>
              <th className="px-4 py-3 font-medium">Severity</th>
              <th className="px-4 py-3 font-medium">Finding</th>
              <th className="px-4 py-3 font-medium">Response</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {data.entries.map((anomaly) => (
              <tr key={anomaly.id}>
                <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">
                  {new Date(anomaly.detectedAt).toLocaleString()}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-zinc-700">
                  {KIND_LABELS[anomaly.kind]}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={anomaly.severity === "critical" ? "amber" : "zinc"}>
                    {anomaly.severity}
                  </Badge>
                </td>
                <td className="max-w-[24rem] px-4 py-2.5 text-zinc-700">
                  <div>{anomaly.summary}</div>
                  <div className="mt-0.5 font-mono text-xs text-zinc-400">
                    {[anomaly.user, anomaly.ip].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <AcknowledgeControl anomaly={anomaly} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.total === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">
            No {status ? `${status} ` : ""}anomalies.
          </div>
        ) : null}
      </Card>

      <div className="mt-4 flex items-center gap-3 text-sm text-zinc-500">
        <span>
          {data.total === 0
            ? ""
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, data.total)} of ${data.total}`}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
