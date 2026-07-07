import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useStudyQueries } from "../api/hooks.js";
import { QUERY_STATUS_TONE } from "../components/QueryPanel.js";
import { Badge, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";

const FILTERS = ["all", "open", "answered", "closed"] as const;

export function QueriesPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/queries" });
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const { data, isPending, isError } = useStudyQueries(
    studyId,
    filter === "all" ? undefined : filter,
  );

  if (isPending) return <Spinner />;
  if (isError || !data) return <ErrorNote>Failed to load queries.</ErrorNote>;

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
      <PageTitle sub="Every manual and system query in this study, most recent first.">
        Queries
      </PageTitle>

      <div className="mb-4 flex gap-1">
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`rounded-lg px-3 py-1.5 text-sm capitalize transition-colors ${
              filter === value
                ? "bg-zinc-900 font-medium text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      {data.length === 0 ? (
        <p className="text-sm text-zinc-500">No {filter === "all" ? "" : `${filter} `}queries.</p>
      ) : (
        <Card>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Origin</th>
                <th className="px-4 py-3 font-medium">Subject</th>
                <th className="px-4 py-3 font-medium">Form / item</th>
                <th className="px-4 py-3 font-medium">Latest message</th>
                <th className="px-4 py-3 font-medium">Opened</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.map((query) => {
                const latest = query.messages[query.messages.length - 1];
                return (
                  <tr key={query.id} className="hover:bg-zinc-50">
                    <td className="px-4 py-3">
                      <Badge tone={QUERY_STATUS_TONE[query.status]}>{query.status}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={query.origin === "system" ? "sky" : "zinc"}>
                        {query.origin}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-medium text-zinc-800">{query.subjectKey}</td>
                    <td className="px-4 py-3">
                      <Link
                        to="/forms/$formInstanceId"
                        params={{ formInstanceId: query.formInstanceId }}
                        className="text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900"
                      >
                        {query.formOid}
                      </Link>
                      {query.itemOid ? (
                        <span className="ml-2 font-mono text-[11px] text-zinc-400">
                          {query.itemOid}
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-zinc-600">
                      {latest ? latest.body : query.checkOid ? `Edit check ${query.checkOid}` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-500">
                      {query.openedBy} · {new Date(query.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
