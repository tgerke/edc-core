import { Link, useParams } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { type AuditFilters, auditQueryString, useAudit } from "../api/hooks.js";
import { Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

const PAGE_SIZE = 50;

function ValueCell({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>
      <pre className="mt-1 overflow-x-auto rounded-lg bg-zinc-50 p-2 font-mono text-xs text-zinc-700">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function AuditPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/audit" });
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [actor, setActor] = useState("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const filters: AuditFilters = {
    ...(action ? { action } : {}),
    ...(entityType ? { entityType } : {}),
    ...(actor ? { actor } : {}),
    limit: PAGE_SIZE,
    offset,
  };
  const { data, isPending, isError } = useAudit(studyId, filters);

  if (isPending) return <Spinner />;
  if (isError || !data) return <ErrorNote>Failed to load the audit trail.</ErrorNote>;

  const selectClass =
    "rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none";
  const setFilter = (set: (v: string) => void) => (value: string) => {
    set(value);
    setOffset(0);
    setExpanded(null);
  };

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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className={selectClass}
          value={action}
          onChange={(e) => setFilter(setAction)(e.target.value)}
        >
          <option value="">All actions</option>
          {data.facets.actions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={entityType}
          onChange={(e) => setFilter(setEntityType)(e.target.value)}
        >
          <option value="">All entities</option>
          {data.facets.entityTypes.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <div className="w-56">
          <Input
            placeholder="Filter by username…"
            value={actor}
            onChange={(e) => setFilter(setActor)(e.target.value)}
          />
        </div>
        <a
          className="ml-auto inline-flex items-center rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-zinc-800 ring-1 ring-zinc-200 hover:bg-zinc-50"
          href={`/api/studies/${studyId}/audit?${auditQueryString(filters)}&format=csv`}
        >
          Export CSV
        </a>
      </div>

      <Card>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Actor</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Entity</th>
              <th className="px-4 py-3 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {data.events.map((event) => (
              <Fragment key={event.id}>
                <tr
                  className="cursor-pointer hover:bg-zinc-50"
                  onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                >
                  <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">
                    {new Date(event.occurredAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-zinc-800">{event.actor}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-700">{event.action}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{event.entityType}</td>
                  <td className="max-w-[16rem] truncate px-4 py-2.5 text-zinc-500">
                    {event.reason ?? ""}
                  </td>
                </tr>
                {expanded === event.id ? (
                  <tr className="bg-zinc-50/50">
                    <td colSpan={5} className="px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <ValueCell label="Old value" value={event.oldValue} />
                        <ValueCell label="New value" value={event.newValue} />
                      </div>
                      <div className="mt-2 font-mono text-[11px] text-zinc-400">
                        {event.entityType} · {event.entityId} · event #{event.id}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 flex items-center gap-3 text-sm text-zinc-500">
        <span>
          {data.total === 0
            ? "No events match."
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
