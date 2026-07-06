import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  type SavedScript,
  type Snapshot,
  type SnapshotTable,
  useExecutions,
  usePermissions,
  usePublishSnapshot,
  useRunR,
  useRunSql,
  useSaveScript,
  useScripts,
  useSnapshots,
  type WorkbenchExecution,
  type WorkbenchResult,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadCsv(columns: string[], rows: unknown[][]) {
  const lines = [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => row.map(csvEscape).join(",")),
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "workbench-result.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function ResultsGrid({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <Card className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left">
            {columns.map((col) => (
              <th key={col} className="px-3 py-2 font-mono text-xs text-zinc-500">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no ids
            <tr key={i} className="border-b border-zinc-100 last:border-0">
              {row.map((value, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
                <td key={j} className="px-3 py-1.5 font-mono text-xs text-zinc-800">
                  {value === null ? <span className="text-zinc-300">∅</span> : String(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-zinc-400">No rows returned.</div>
      ) : null}
    </Card>
  );
}

function editorClass() {
  return "h-44 w-full rounded-xl border border-zinc-300 bg-white p-3 font-mono text-sm shadow-sm focus:border-zinc-400 focus:outline-none";
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

function SqlPanel({
  studyId,
  snapshot,
  canRun,
  sql,
  setSql,
}: {
  studyId: string;
  snapshot: Snapshot;
  canRun: boolean;
  sql: string;
  setSql: (sql: string) => void;
}) {
  const runSql = useRunSql(studyId);
  const [result, setResult] = useState<WorkbenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!sql.trim() || runSql.isPending) return;
    setError(null);
    try {
      setResult(await runSql.mutateAsync({ snapshotId: snapshot.id, sql }));
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <textarea
        className={editorClass()}
        placeholder={`SELECT event_oid, count(*) AS forms\nFROM ${snapshot.manifest?.tables.find((t) => t.kind === "dataset")?.table ?? "subjects"}\nGROUP BY event_oid`}
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
        {result ? (
          <span className="text-xs text-zinc-500">
            {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
            {result.truncated ? " (truncated)" : ""} · {result.elapsedMs} ms · snapshot v
            {result.lakeVersion}
          </span>
        ) : null}
        {result && result.rowCount > 0 ? (
          <Button variant="ghost" onClick={() => downloadCsv(result.columns, result.rows)}>
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
      {result ? <ResultsGrid columns={result.columns} rows={result.rows} /> : null}
    </div>
  );
}

function RPanel({
  studyId,
  snapshot,
  canRun,
}: {
  studyId: string;
  snapshot: Snapshot;
  canRun: boolean;
}) {
  const { data: scripts } = useScripts(studyId);
  const saveScript = useSaveScript(studyId);
  const runR = useRunR(studyId);
  const { data: executions } = useExecutions(studyId);

  const [content, setContent] = useState("");
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState<SavedScript | null>(null);
  const [execution, setExecution] = useState<WorkbenchExecution | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rScripts = (scripts ?? []).filter((s) => s.language === "r");

  async function run() {
    if (!content.trim() || runR.isPending) return;
    setError(null);
    const pinned =
      loaded && loaded.content === content
        ? { scriptId: loaded.id, scriptVersion: loaded.version }
        : {};
    try {
      setExecution(await runR.mutateAsync({ snapshotId: snapshot.id, content, ...pinned }));
    } catch (err) {
      setExecution(null);
      setError((err as Error).message);
    }
  }

  async function save() {
    if (!name.trim() || !content.trim() || saveScript.isPending) return;
    setError(null);
    try {
      setLoaded(await saveScript.mutateAsync({ name: name.trim(), language: "r", content }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
          value={loaded?.id ?? ""}
          onChange={(e) => {
            const script = rScripts.find((s) => s.id === e.target.value) ?? null;
            setLoaded(script);
            if (script) {
              setContent(script.content);
              setName(script.name);
            }
          }}
        >
          <option value="">unsaved script…</option>
          {rScripts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} (v{s.version})
            </option>
          ))}
        </select>
        <input
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
          placeholder="script name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          variant="secondary"
          onClick={save}
          disabled={!canRun || saveScript.isPending || !name.trim() || !content.trim()}
        >
          {saveScript.isPending ? "Saving…" : loaded ? "Save new version" : "Save"}
        </Button>
      </div>
      <textarea
        className={editorClass()}
        placeholder={
          '# The snapshot is exposed as read-only, version-pinned views.\n# lake_read("table") returns a data.frame; lake_query(sql) runs DuckDB SQL.\nvs <- lake_read("subjects")\nnrow(vs)\nlake_query("SELECT site_oid, count(*) AS n FROM subjects GROUP BY site_oid")'
        }
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void run();
          }
        }}
        spellCheck={false}
      />
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={run} disabled={!canRun || runR.isPending || !content.trim()}>
          {runR.isPending ? "Running in R…" : "Run (⌘⏎)"}
        </Button>
        {execution ? (
          <span className="text-xs text-zinc-500">
            {execution.status} · {execution.elapsedMs} ms
            {loaded && execution.scriptVersion
              ? ` · ${loaded.name} v${execution.scriptVersion}`
              : ""}
          </span>
        ) : null}
        {execution?.result ? (
          <Button
            variant="ghost"
            onClick={() =>
              execution.result && downloadCsv(execution.result.columns, execution.result.rows)
            }
          >
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
      {execution?.error ? (
        <div className="mt-3">
          <ErrorNote>
            <pre className="whitespace-pre-wrap font-mono text-xs">{execution.error}</pre>
          </ErrorNote>
        </div>
      ) : null}
      {execution?.stdout ? (
        <Card className="mt-4 bg-zinc-900 p-3">
          <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-100">
            {execution.stdout}
          </pre>
        </Card>
      ) : null}
      {execution?.result ? (
        <ResultsGrid columns={execution.result.columns} rows={execution.result.rows} />
      ) : null}

      {executions && executions.length > 0 ? (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Execution history
          </h3>
          <Card>
            <ul className="divide-y divide-zinc-100 text-sm">
              {executions.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                  <Badge tone={e.status === "succeeded" ? "emerald" : "amber"}>{e.status}</Badge>
                  <span className="font-mono text-xs text-zinc-600">
                    {e.content.split("\n")[0]?.slice(0, 60)}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-zinc-400">
                    {e.executedBy} · {new Date(e.executedAt).toLocaleString()} · {e.elapsedMs} ms
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

export function WorkbenchPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/workbench" });
  const { data: snapshots, isPending } = useSnapshots(studyId);
  const { data: permissions } = usePermissions(studyId);
  const publish = usePublishSnapshot(studyId);

  const published = useMemo(
    () => (snapshots ?? []).filter((s: Snapshot) => s.status === "published"),
    [snapshots],
  );
  const [snapshotId, setSnapshotId] = useState("");
  const selected = published.find((s) => s.id === snapshotId) ?? published[0];
  useEffect(() => {
    if (!snapshotId && published[0]) setSnapshotId(published[0].id);
  }, [snapshotId, published]);

  const [mode, setMode] = useState<"sql" | "r">("sql");
  const [sql, setSql] = useState("");
  const [note, setNote] = useState("");

  const canExport = permissions?.includes("export.data") ?? false;
  const canRun = permissions?.includes("analytics.run") ?? false;

  return (
    <div>
      <PageTitle sub="Self-service SQL and R over published snapshots — every run is read-only against an immutable point-in-time dataset. Operational analytics, not validated statistical output.">
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
                onQuery={(starter) => {
                  setMode("sql");
                  setSql(starter);
                }}
              />
            ))}
          </div>

          <div>
            <div className="mb-3 flex gap-1 rounded-lg bg-zinc-100 p-1 text-sm w-fit">
              {(["sql", "r"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`rounded-md px-4 py-1 font-medium ${mode === m ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800"}`}
                  onClick={() => setMode(m)}
                >
                  {m === "sql" ? "SQL" : "R"}
                </button>
              ))}
            </div>
            {!canRun ? (
              <div className="mb-3 text-xs text-zinc-400">
                You need the analytics.run permission to execute queries.
              </div>
            ) : null}
            {mode === "sql" ? (
              <SqlPanel
                studyId={studyId}
                snapshot={selected}
                canRun={canRun}
                sql={sql}
                setSql={setSql}
              />
            ) : (
              <RPanel studyId={studyId} snapshot={selected} canRun={canRun} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
