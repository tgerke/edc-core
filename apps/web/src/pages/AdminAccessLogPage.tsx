import { useState } from "react";
import { type AccessLogFilters, accessLogQueryString, useAccessLog } from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

const PAGE_SIZE = 50;

function statusTone(code: number): "emerald" | "amber" {
  return code < 400 ? "emerald" : "amber";
}

export function AdminAccessLogPage() {
  const [user, setUser] = useState("");
  const [ip, setIp] = useState("");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);

  const filters: AccessLogFilters = {
    ...(user ? { user } : {}),
    ...(ip ? { ip } : {}),
    ...(path ? { path } : {}),
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    offset,
  };
  const { data, isPending, isError } = useAccessLog(filters);

  if (isPending) return <Spinner />;
  if (isError || !data) return <ErrorNote>Failed to load the access log.</ErrorNote>;

  const setFilter = (set: (v: string) => void) => (value: string) => {
    set(value);
    setOffset(0);
  };

  return (
    <div>
      <PageTitle sub="Every API request — who, from where, and with what result. Sessions are bound to the client they were issued to; violations appear in the audit trail.">
        Access log
      </PageTitle>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-48">
          <Input
            placeholder="Username…"
            value={user}
            onChange={(e) => setFilter(setUser)(e.target.value)}
          />
        </div>
        <div className="w-40">
          <Input
            placeholder="IP address…"
            value={ip}
            onChange={(e) => setFilter(setIp)(e.target.value)}
          />
        </div>
        <div className="w-48">
          <Input
            placeholder="Path prefix…"
            value={path}
            onChange={(e) => setFilter(setPath)(e.target.value)}
          />
        </div>
        <div className="w-28">
          <Input
            placeholder="Status…"
            value={status}
            onChange={(e) => setFilter(setStatus)(e.target.value)}
          />
        </div>
        <a
          className="ml-auto inline-flex items-center rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-zinc-800 ring-1 ring-zinc-200 hover:bg-zinc-50"
          href={`/api/admin/access-log?${accessLogQueryString(filters)}&format=csv`}
        >
          Export CSV
        </a>
      </div>

      <Card>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Request</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">IP</th>
              <th className="px-4 py-3 font-medium">Client</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {data.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap px-4 py-2.5 text-zinc-500">
                  {new Date(entry.occurredAt).toLocaleString()}
                </td>
                <td className="px-4 py-2.5">
                  {entry.user ? (
                    <span className="font-medium text-zinc-800">{entry.user}</span>
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>
                <td className="max-w-[20rem] truncate px-4 py-2.5 font-mono text-xs text-zinc-700">
                  {entry.method} {entry.path}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone(entry.statusCode)}>{entry.statusCode}</Badge>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-500">
                  {entry.ip ?? ""}
                </td>
                <td className="max-w-[14rem] truncate px-4 py-2.5 text-xs text-zinc-400">
                  {entry.userAgent ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 flex items-center gap-3 text-sm text-zinc-500">
        <span>
          {data.total === 0
            ? "No requests match."
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
