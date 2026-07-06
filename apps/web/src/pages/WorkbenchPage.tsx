import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  type Snapshot,
  type SnapshotTable,
  usePermissions,
  usePublishSnapshot,
  useRunSql,
  useSnapshots,
  type WorkbenchResult,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadResultCsv(result: WorkbenchResult) {
  const lines = [
    result.columns.map(csvEscape).join(","),
    ...result.rows.map((row) => row.map(csvEscape).join(",")),
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "workbench-result.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function TableCard({
  table,
  snapshotId,
  canExport,
  onQuery,
}: {
  table: SnapshotTable;
  snapshotId: string;
  canExport: boolean;
  onQuery: (sql: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const exportHref = (format: string) =>
    `/api/snapshots/${snapshotId}/export?table=${encodeURIComponent(table.table)}&format=${format}`;
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="font-mono text-sm font-medium text-zinc-800 hover:underline"
          title="Insert a starter query"
          onClick={() => onQuery(`SELECT *\nFROM ${table.table}\nLIMIT 100`)}
        >
          {table.table}
        </button>
        <Badge tone={table.kind === "dataset" ? "sky" : "zinc"}>
          {table.kind === "dataset" ? (table.label ?? "dataset") : "core"}
        </Badge>
        <span className="ml-auto text-xs text-zinc-400">
          {table.rows} row{table.rows === 1 ? "" : "s"}
        </span>
      </div>
      {table.columns ? (
        <button
          type="button"
          className="mt-1 text-xs text-zinc-500 hover:text-zinc-700"
          onClick={() => setOpen(!open)}
        >
          {open ? "hide" : "show"} {table.columns.length} item column
          {table.columns.length === 1 ? "" : "s"}
        </button>
      ) : null}
      {open && table.columns ? (
        <ul className="mt-2 space-y-1 border-t border-zinc-100 pt-2 text-xs">
          {table.columns.map((col) => (
            <li key={col.column} className="flex items-baseline gap-2">
              <span className="font-mono text-zinc-700">{col.column}</span>
              <span className="text-zinc-400">{col.dataType}</span>
              <span className="truncate text-zinc-500">{col.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {canExport ? (
        <div className="mt-2 flex gap-2 text-xs">
          <a className="text-zinc-500 underline hover:text-zinc-800" href={exportHref("csv")}>
            CSV
          </a>
          <a className="text-zinc-500 underline hover:text-zinc-800" href={exportHref("parquet")}>
            Parquet
          </a>
          {table.kind === "dataset" ? (
            <a
              className="text-zinc-500 underline hover:text-zinc-800"
              href={exportHref("dataset-json")}
            >
              Dataset-JSON
            </a>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export function WorkbenchPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/workbench" });
  const { data: snapshots, isPending } = useSnapshots(studyId);
  const { data: permissions } = usePermissions(studyId);
  const publish = usePublishSnapshot(studyId);
  const runSql = useRunSql(studyId);

  const published = useMemo(
    () => (snapshots ?? []).filter((s: Snapshot) => s.status === "published"),
    [snapshots],
  );
  const [snapshotId, setSnapshotId] = useState("");
  const selected = published.find((s) => s.id === snapshotId) ?? published[0];
  useEffect(() => {
    if (!snapshotId && published[0]) setSnapshotId(published[0].id);
  }, [snapshotId, published]);

  const [sql, setSql] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<WorkbenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canExport = permissions?.includes("export.data") ?? false;
  const canRun = permissions?.includes("analytics.run") ?? false;

  async function run() {
    if (!selected || !sql.trim() || runSql.isPending) return;
    setError(null);
    try {
      setResult(await runSql.mutateAsync({ snapshotId: selected.id, sql }));
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <PageTitle sub="Self-service SQL over published snapshots — every query runs read-only against an immutable point-in-time dataset. Operational analytics, not validated statistical output.">
        Analytics workbench
      </PageTitle>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label className="text-sm text-zinc-600" htmlFor="snapshot-select">
          Snapshot
        </label>
        <select
          id="snapshot-select"
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
          value={selected?.id ?? ""}
          onChange={(e) => setSnapshotId(e.target.value)}
        >
          {published.map((s) => (
            <option key={s.id} value={s.id}>
              v{s.lakeVersion} · {new Date(s.publishedAt ?? s.createdAt).toLocaleString()}
              {s.note ? ` · ${s.note}` : ""}
            </option>
          ))}
        </select>
        {canExport ? (
          <div className="ml-auto flex items-center gap-2">
            <input
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
              placeholder="note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              onClick={async () => {
                await publish.mutateAsync(note.trim() ? { note: note.trim() } : {});
                setNote("");
              }}
              disabled={publish.isPending}
            >
              {publish.isPending ? "Publishing…" : "Publish snapshot"}
            </Button>
          </div>
        ) : null}
      </div>
      {publish.isError ? <ErrorNote>{(publish.error as Error).message}</ErrorNote> : null}

      {isPending ? <Spinner /> : null}
      {!isPending && published.length === 0 ? (
        <Card className="p-10 text-center text-sm text-zinc-500">
          No published snapshots yet.{" "}
          {canExport
            ? "Publish one to freeze a point-in-time dataset for analysis."
            : "Ask a data manager to publish one."}
        </Card>
      ) : null}

      {selected?.manifest ? (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Tables · build v{selected.manifest.metadataVersion}
            </h2>
            {selected.manifest.tables.map((table) => (
              <TableCard
                key={table.table}
                table={table}
                snapshotId={selected.id}
                canExport={canExport}
                onQuery={setSql}
              />
            ))}
          </div>

          <div>
            <textarea
              className="h-44 w-full rounded-xl border border-zinc-300 bg-white p-3 font-mono text-sm shadow-sm focus:border-zinc-400 focus:outline-none"
              placeholder={`SELECT event_oid, count(*) AS forms\nFROM ${selected.manifest.tables.find((t) => t.kind === "dataset")?.table ?? "subjects"}\nGROUP BY event_oid`}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void run();
                }
              }}
              spellCheck={false}
            />
            <div className="mt-2 flex items-center gap-3">
              <Button onClick={run} disabled={!canRun || runSql.isPending || !sql.trim()}>
                {runSql.isPending ? "Running…" : "Run (⌘⏎)"}
              </Button>
              {!canRun ? (
                <span className="text-xs text-zinc-400">
                  You need the analytics.run permission to execute queries.
                </span>
              ) : null}
              {result ? (
                <span className="text-xs text-zinc-500">
                  {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
                  {result.truncated ? " (truncated)" : ""} · {result.elapsedMs} ms · snapshot v
                  {result.lakeVersion}
                </span>
              ) : null}
              {result && result.rowCount > 0 ? (
                <Button variant="ghost" onClick={() => downloadResultCsv(result)}>
                  Download CSV
                </Button>
              ) : null}
            </div>

            {error ? (
              <div className="mt-3">
                <ErrorNote>
                  <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
                </ErrorNote>
              </div>
            ) : null}

            {result ? (
              <Card className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left">
                      {result.columns.map((col) => (
                        <th key={col} className="px-3 py-2 font-mono text-xs text-zinc-500">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no ids
                      <tr key={i} className="border-b border-zinc-100 last:border-0">
                        {row.map((value, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
                          <td key={j} className="px-3 py-1.5 font-mono text-xs text-zinc-800">
                            {value === null ? (
                              <span className="text-zinc-300">∅</span>
                            ) : (
                              String(value)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.rowCount === 0 ? (
                  <div className="p-6 text-center text-sm text-zinc-400">No rows returned.</div>
                ) : null}
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
