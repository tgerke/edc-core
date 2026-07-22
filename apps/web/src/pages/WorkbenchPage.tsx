import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  type QueryBatchResult,
  type QueryBatchTarget,
  type SavedScript,
  type ScriptLanguage,
  type Snapshot,
  type SnapshotTable,
  useCreateQueryBatch,
  useExecutions,
  usePermissions,
  usePublishSnapshot,
  useRunScript,
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

const BATCH_LIMIT = 500;

/** Auto-map by the lake's key column names; anything else is picked by hand. */
const AUTO_MAP: [keyof ColumnMapping, string][] = [
  ["subjectKey", "subject_key"],
  ["eventOid", "event_oid"],
  ["eventRepeatKey", "event_repeat_key"],
  ["formOid", "form_oid"],
  ["formRepeatKey", "form_repeat_key"],
  ["itemGroupRepeatKey", "item_group_repeat_key"],
];

interface ColumnMapping {
  subjectKey: number;
  formOid: number;
  eventOid: number;
  eventRepeatKey: number;
  formRepeatKey: number;
  itemGroupRepeatKey: number;
}

interface ItemColumnChoice {
  key: string;
  resultIdx: number;
  itemOid: string;
  itemGroupOid: string;
  label: string;
}

const SKIP_REASON_LABEL: Record<string, string> = {
  subject_not_found: "subject not found",
  event_not_found: "event not found",
  form_not_found: "form not found",
  ambiguous_target: "ambiguous target — map an event column",
  unknown_item: "item not on this form's build",
  duplicate_open_query: "already has an open query",
  value_changed: "value changed since this snapshot",
  site_forbidden: "outside your site scope",
  form_locked: "form is locked",
};

/**
 * Listing rows → queries (ADR-0015). The dialog maps result columns onto
 * query targets, previews server-side resolution with dryRun, then creates.
 * The server re-validates everything against live capture; this flow only
 * proposes.
 */
function CreateQueriesDialog({
  studyId,
  snapshot,
  executionId,
  columns,
  rows,
  onClose,
}: {
  studyId: string;
  snapshot: Snapshot;
  executionId?: string;
  columns: string[];
  rows: unknown[][];
  onClose: () => void;
}) {
  const createBatch = useCreateQueryBatch(studyId);
  const candidateRows = useMemo(() => rows.slice(0, BATCH_LIMIT), [rows]);

  const [mapping, setMapping] = useState<ColumnMapping>(() => {
    const auto = Object.fromEntries(
      AUTO_MAP.map(([field, name]) => [field, columns.indexOf(name)]),
    ) as unknown as ColumnMapping;
    return auto;
  });
  const itemChoices = useMemo<ItemColumnChoice[]>(() => {
    const choices: ItemColumnChoice[] = [];
    for (const table of snapshot.manifest?.tables ?? []) {
      if (!table.columns || !table.itemGroupOid) continue;
      for (const col of table.columns) {
        const resultIdx = columns.indexOf(col.column);
        if (resultIdx < 0) continue;
        choices.push({
          key: `${table.table}.${col.column}`,
          resultIdx,
          itemOid: col.itemOid,
          itemGroupOid: table.itemGroupOid,
          label: `${col.column} (${table.table})`,
        });
      }
    }
    return choices;
  }, [snapshot, columns]);
  const [itemKey, setItemKey] = useState(() =>
    itemChoices.length === 1 ? itemChoices[0]?.key : "",
  );
  const item = itemChoices.find((c) => c.key === itemKey) ?? null;

  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(candidateRows.map((_, i) => i)),
  );
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<QueryBatchResult | null>(null);
  const [created, setCreated] = useState<QueryBatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = mapping.subjectKey >= 0 && mapping.formOid >= 0 && message.trim().length > 0;

  function buildTargets(): { targets: QueryBatchTarget[]; rowForTarget: number[] } {
    const targets: QueryBatchTarget[] = [];
    const rowForTarget: number[] = [];
    const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    for (const [i, row] of candidateRows.entries()) {
      if (!selected.has(i)) continue;
      const subjectKey = str(row[mapping.subjectKey]);
      const formOid = str(row[mapping.formOid]);
      if (!subjectKey || !formOid) continue;
      const eventOid = mapping.eventOid >= 0 ? str(row[mapping.eventOid]) : undefined;
      const eventRepeatKey =
        mapping.eventRepeatKey >= 0 ? num(row[mapping.eventRepeatKey]) : undefined;
      const formRepeatKey =
        mapping.formRepeatKey >= 0 ? num(row[mapping.formRepeatKey]) : undefined;
      const itemGroupRepeatKey =
        mapping.itemGroupRepeatKey >= 0 ? num(row[mapping.itemGroupRepeatKey]) : undefined;
      targets.push({
        subjectKey,
        formOid,
        ...(eventOid ? { eventOid } : {}),
        ...(eventRepeatKey ? { eventRepeatKey } : {}),
        ...(formRepeatKey ? { formRepeatKey } : {}),
        ...(itemGroupRepeatKey ? { itemGroupRepeatKey } : {}),
        ...(item
          ? {
              itemOid: item.itemOid,
              itemGroupOid: item.itemGroupOid,
              snapshotValue: row[item.resultIdx] === null ? null : String(row[item.resultIdx]),
            }
          : {}),
      });
      rowForTarget.push(i);
    }
    return { targets, rowForTarget };
  }

  async function run(dryRun: boolean) {
    setError(null);
    const { targets } = buildTargets();
    if (targets.length === 0) {
      setError("No usable rows: the subject and form columns must be mapped and non-empty.");
      return;
    }
    try {
      const result = await createBatch.mutateAsync({
        dryRun,
        message: message.trim(),
        targets,
        ...(executionId ? { executionId } : {}),
      });
      if (dryRun) setPreview(result);
      else setCreated(result);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const mapSelect = (field: keyof ColumnMapping, label: string, required = false) => (
    <label className="grid gap-1 text-sm">
      <span className="text-zinc-600">
        {label}
        {required ? " *" : ""}
      </span>
      <select
        className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
        value={mapping[field]}
        onChange={(e) => {
          setMapping({ ...mapping, [field]: Number(e.target.value) });
          setPreview(null);
        }}
      >
        <option value={-1}>—</option>
        {columns.map((col, i) => (
          <option key={col} value={i}>
            {col}
          </option>
        ))}
      </select>
    </label>
  );

  if (created) {
    return (
      <div className="fixed inset-0 z-10 flex items-center justify-center bg-zinc-900/40 p-4">
        <Card className="w-full max-w-lg p-6">
          <h3 className="text-base font-semibold text-zinc-900">Queries created</h3>
          <p className="mt-2 text-sm text-zinc-600">
            {created.created} created · {created.skipped} skipped.
          </p>
          {created.skipped > 0 ? (
            <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-xs text-zinc-500">
              {created.results
                .filter((r) => r.outcome === "skipped")
                .map((r) => (
                  <li key={r.index}>
                    row {r.index + 1}: {SKIP_REASON_LABEL[r.reason ?? ""] ?? r.reason}
                  </li>
                ))}
            </ul>
          ) : null}
          <div className="mt-4 flex items-center gap-3">
            <Link
              to="/studies/$studyId/queries"
              params={{ studyId }}
              className="text-sm font-medium text-zinc-900 underline"
            >
              View queries
            </Link>
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const previewByTarget = new Map((preview?.results ?? []).map((r) => [r.index, r]));
  const { targets: currentTargets, rowForTarget } = buildTargets();
  const targetIdxByRow = new Map(rowForTarget.map((rowIdx, targetIdx) => [rowIdx, targetIdx]));

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-zinc-900/40 p-4">
      <Card className="flex max-h-[90vh] w-full max-w-3xl flex-col p-6">
        <h3 className="text-base font-semibold text-zinc-900">Create queries from listing</h3>
        <p className="mt-1 text-sm text-zinc-500">
          Rows are re-checked against live data before anything is created — snapshot v
          {snapshot.lakeVersion} is the evidence, not the target.
          {rows.length > BATCH_LIMIT ? ` Showing the first ${BATCH_LIMIT} rows.` : ""}
        </p>
        {error ? (
          <div className="mt-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {mapSelect("subjectKey", "Subject column", true)}
          {mapSelect("formOid", "Form column", true)}
          {mapSelect("eventOid", "Event column")}
          {mapSelect("eventRepeatKey", "Event repeat")}
          {mapSelect("formRepeatKey", "Form repeat")}
          {mapSelect("itemGroupRepeatKey", "Group repeat")}
        </div>
        <label className="mt-3 grid gap-1 text-sm">
          <span className="text-zinc-600">Item column (targets the query at a field)</span>
          <select
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
            value={itemKey}
            onChange={(e) => {
              setItemKey(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">form-level query (no item)</option>
            {itemChoices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          <span className="text-zinc-600">Query message *</span>
          <textarea
            className="h-16 rounded-lg border border-zinc-300 p-2 text-sm"
            placeholder="e.g. Value flagged by the weekly cleaning listing — please verify against source."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-zinc-50">
              <tr className="text-left text-zinc-500">
                <th className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.size === candidateRows.length}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(candidateRows.map((_, i) => i))
                          : new Set<number>(),
                      )
                    }
                  />
                </th>
                <th className="px-2 py-1.5">subject</th>
                <th className="px-2 py-1.5">form</th>
                {item ? <th className="px-2 py-1.5">value</th> : null}
                {preview ? <th className="px-2 py-1.5">preview</th> : null}
              </tr>
            </thead>
            <tbody>
              {candidateRows.map((row, i) => {
                const targetIdx = targetIdxByRow.get(i);
                const outcome =
                  targetIdx !== undefined ? previewByTarget.get(targetIdx) : undefined;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional listing rows
                  <tr key={i} className="border-t border-zinc-100">
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          setSelected(next);
                          setPreview(null);
                        }}
                      />
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {mapping.subjectKey >= 0 ? String(row[mapping.subjectKey] ?? "") : "—"}
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {mapping.formOid >= 0 ? String(row[mapping.formOid] ?? "") : "—"}
                    </td>
                    {item ? (
                      <td className="px-2 py-1 font-mono">{String(row[item.resultIdx] ?? "∅")}</td>
                    ) : null}
                    {preview ? (
                      <td className="px-2 py-1">
                        {outcome ? (
                          outcome.outcome === "would_create" ? (
                            <Badge tone="emerald">will create</Badge>
                          ) : (
                            <Badge tone="amber">
                              {SKIP_REASON_LABEL[outcome.reason ?? ""] ?? outcome.reason}
                            </Badge>
                          )
                        ) : (
                          <span className="text-zinc-300">not selected</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => run(true)}
            disabled={!ready || createBatch.isPending}
          >
            {createBatch.isPending ? "Checking…" : "Preview"}
          </Button>
          <Button
            onClick={() => run(false)}
            disabled={!ready || !preview || createBatch.isPending}
            title={preview ? "" : "Preview first"}
          >
            Create{" "}
            {preview ? preview.results.filter((r) => r.outcome === "would_create").length : ""}{" "}
            queries
          </Button>
          <span className="text-xs text-zinc-400">
            {currentTargets.length} of {candidateRows.length} rows selected and mappable
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </Card>
    </div>
  );
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
  canManageQueries,
  sql,
  setSql,
}: {
  studyId: string;
  snapshot: Snapshot;
  canRun: boolean;
  canManageQueries: boolean;
  sql: string;
  setSql: (sql: string) => void;
}) {
  const runSql = useRunSql(studyId);
  const [result, setResult] = useState<WorkbenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
        {result && result.rowCount > 0 && canManageQueries ? (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            Create queries…
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
      {creating && result ? (
        <CreateQueriesDialog
          studyId={studyId}
          snapshot={snapshot}
          executionId={result.executionId}
          columns={result.columns}
          rows={result.rows}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}

const LANGUAGE_LABEL: Record<ScriptLanguage | "sql", string> = {
  r: "R",
  python: "Python",
  sql: "SQL",
};

const SCRIPT_PLACEHOLDER: Record<ScriptLanguage, string> = {
  r: '# The snapshot is exposed as read-only, version-pinned views.\n# lake_read("table") returns a data.frame; lake_query(sql) runs DuckDB SQL.\nvs <- lake_read("subjects")\nnrow(vs)\nlake_query("SELECT site_oid, count(*) AS n FROM subjects GROUP BY site_oid")',
  python:
    '# The snapshot is exposed as read-only, version-pinned views.\n# lake_read("table") returns a pandas DataFrame; lake_query(sql) runs DuckDB SQL.\n# The last expression becomes the result grid.\nvs = lake_read("subjects")\nlen(vs)\nlake_query("SELECT site_oid, count(*) AS n FROM subjects GROUP BY site_oid")',
};

function ScriptPanel({
  studyId,
  snapshot,
  canRun,
  canManageQueries,
  language,
}: {
  studyId: string;
  snapshot: Snapshot;
  canRun: boolean;
  canManageQueries: boolean;
  language: ScriptLanguage;
}) {
  const { data: scripts } = useScripts(studyId);
  const saveScript = useSaveScript(studyId);
  const runScript = useRunScript(studyId, language);
  const { data: executions } = useExecutions(studyId);

  const [content, setContent] = useState("");
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState<SavedScript | null>(null);
  const [execution, setExecution] = useState<WorkbenchExecution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const languageScripts = (scripts ?? []).filter((s) => s.language === language);

  async function run() {
    if (!content.trim() || runScript.isPending) return;
    setError(null);
    const pinned =
      loaded && loaded.content === content
        ? { scriptId: loaded.id, scriptVersion: loaded.version }
        : {};
    try {
      setExecution(await runScript.mutateAsync({ snapshotId: snapshot.id, content, ...pinned }));
    } catch (err) {
      setExecution(null);
      setError((err as Error).message);
    }
  }

  async function save() {
    if (!name.trim() || !content.trim() || saveScript.isPending) return;
    setError(null);
    try {
      setLoaded(await saveScript.mutateAsync({ name: name.trim(), language, content }));
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
            const script = languageScripts.find((s) => s.id === e.target.value) ?? null;
            setLoaded(script);
            if (script) {
              setContent(script.content);
              setName(script.name);
            }
          }}
        >
          <option value="">unsaved script…</option>
          {languageScripts.map((s) => (
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
        placeholder={SCRIPT_PLACEHOLDER[language]}
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
        <Button onClick={run} disabled={!canRun || runScript.isPending || !content.trim()}>
          {runScript.isPending ? `Running in ${LANGUAGE_LABEL[language]}…` : "Run (⌘⏎)"}
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
        {execution?.result && execution.result.rows.length > 0 && canManageQueries ? (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            Create queries…
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
      {creating && execution?.result ? (
        <CreateQueriesDialog
          studyId={studyId}
          snapshot={snapshot}
          executionId={execution.id}
          columns={execution.result.columns}
          rows={execution.result.rows}
          onClose={() => setCreating(false)}
        />
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
                  <Badge tone="zinc">{LANGUAGE_LABEL[e.language]}</Badge>
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

  const [mode, setMode] = useState<"sql" | ScriptLanguage>("sql");
  const [sql, setSql] = useState("");
  const [note, setNote] = useState("");

  const canExport = permissions?.includes("export.data") ?? false;
  const canRun = permissions?.includes("analytics.run") ?? false;
  const canManageQueries = permissions?.includes("query.manage") ?? false;

  return (
    <div>
      <PageTitle sub="Self-service SQL, R, and Python over published snapshots — every run is read-only against an immutable point-in-time dataset. Operational analytics, not validated statistical output.">
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
              {(["sql", "r", "python"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`rounded-md px-4 py-1 font-medium ${mode === m ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800"}`}
                  onClick={() => setMode(m)}
                >
                  {m === "sql" ? "SQL" : LANGUAGE_LABEL[m]}
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
                canManageQueries={canManageQueries}
                sql={sql}
                setSql={setSql}
              />
            ) : (
              // Keyed by language so editor state doesn't bleed between R and Python.
              <ScriptPanel
                key={mode}
                studyId={studyId}
                snapshot={selected}
                canRun={canRun}
                canManageQueries={canManageQueries}
                language={mode}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
