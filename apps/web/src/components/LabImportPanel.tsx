import { useRef, useState } from "react";
import {
  type LabImportIssueRow,
  type LabImportPreview,
  type LabImportRun,
  useLabImportMappings,
  useLabImportRun,
  useLabImportRuns,
  useSaveLabImportMapping,
  useStartLabImport,
  useValidateLabImport,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Spinner } from "./ui.js";

const OUTCOME_LABELS: Record<string, string> = {
  imported: "imported",
  skipped_unchanged: "unchanged (skipped)",
  conflict_existing_value: "conflicts with existing value",
  skipped_form_status: "form past data entry",
  skipped_blinded: "blinded (no data.unblind)",
  skipped_pinned_build: "form pinned to older build",
  error_no_subject: "unknown subject",
  error_site_mismatch: "site mismatch",
  error_no_event: "unmapped visit",
  error_unknown_test: "unknown test code",
  error_bad_value: "bad value",
  error_write_failed: "write failed",
};

const GOOD_OUTCOMES = new Set(["imported", "skipped_unchanged"]);

const CONFIG_TEMPLATE = `{
  "formOid": "FO.LAB",
  "columns": {
    "subjectKey": "USUBJID",
    "siteOid": "SITEID",
    "visit": "VISIT",
    "testCode": "LBTESTCD",
    "result": "LBORRES",
    "unit": "LBORRESU",
    "collectionDate": "LBDTC"
  },
  "visitMap": { "SCREENING": "SE.SCR" },
  "tests": {
    "ALT": { "itemGroupOid": "IG.LAB", "itemOid": "IT.ALT", "unitItemOid": "IT.ALTU" }
  },
  "collectionDateItem": { "itemGroupOid": "IG.LAB", "itemOid": "IT.LBDT" }
}`;

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadIssuesCsv(issues: LabImportIssueRow[], fileName: string) {
  const lines = [
    "line,subject,test,outcome,message",
    ...issues.map((issue) =>
      [issue.line, issue.subjectKey, issue.testCode, issue.outcome, issue.message]
        .map(csvField)
        .join(","),
    ),
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function CountsTable({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return <p className="text-sm text-zinc-500">No rows.</p>;
  return (
    <ul className="space-y-1 text-sm text-zinc-700">
      {entries.map(([outcome, count]) => (
        <li key={outcome} className="flex items-center gap-2">
          <Badge tone={GOOD_OUTCOMES.has(outcome) ? "emerald" : "amber"}>{count}</Badge>
          <span>{OUTCOME_LABELS[outcome] ?? outcome}</span>
        </li>
      ))}
    </ul>
  );
}

function IssueList({
  issues,
  truncatedNote,
}: {
  issues: LabImportIssueRow[];
  truncatedNote?: string | undefined;
}) {
  if (issues.length === 0) return null;
  return (
    <div className="rounded-md bg-amber-50 px-2 py-1 text-sm text-amber-800 ring-1 ring-amber-200">
      <ul className="list-inside list-disc">
        {issues.slice(0, 8).map((issue) => (
          <li key={`${issue.line}:${issue.testCode}:${issue.outcome}`}>
            line {issue.line} ({issue.subjectKey || "?"} {issue.testCode}):{" "}
            {issue.message || (OUTCOME_LABELS[issue.outcome] ?? issue.outcome)}
          </li>
        ))}
      </ul>
      {issues.length > 8 ? <div className="mt-1">…and {issues.length - 8} more</div> : null}
      {truncatedNote ? <div className="mt-1">{truncatedNote}</div> : null}
    </div>
  );
}

function RunReport({ run }: { run: LabImportRun }) {
  const progress =
    run.totalRows === 0 ? 100 : Math.round((run.processedRows / run.totalRows) * 100);
  return (
    <div className="space-y-2 text-sm text-zinc-700">
      <div className="flex items-center gap-2">
        <Badge
          tone={run.status === "completed" ? "emerald" : run.status === "running" ? "sky" : "amber"}
        >
          {run.status.replace(/_/g, " ")}
        </Badge>
        <span>
          {run.processedRows} of {run.totalRows} rows
        </span>
        {run.fileName ? <span className="text-zinc-400">({run.fileName})</span> : null}
      </div>
      {run.status === "running" ? (
        <div className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-zinc-100">
          <div
            className="h-full rounded-full bg-sky-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : (
        <>
          <CountsTable counts={run.counts} />
          <IssueList
            issues={run.issues}
            truncatedNote={
              run.issues.length >= 200 ? "Only the first 200 issues are recorded." : undefined
            }
          />
          {run.issues.length > 0 ? (
            <Button
              variant="secondary"
              onClick={() => downloadIssuesCsv(run.issues, `lab-import-issues-${run.id}.csv`)}
            >
              Download issues (CSV)
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

export function LabImportPanel({ studyId, studyName }: { studyId: string; studyName: string }) {
  const { data: mappings, isPending } = useLabImportMappings(studyId);
  const saveMapping = useSaveLabImportMapping(studyId);
  const validate = useValidateLabImport(studyId);
  const start = useStartLabImport(studyId);
  const { data: runs } = useLabImportRuns(studyId);

  const [mappingId, setMappingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: string; name: string; json: string } | null>(null);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<LabImportPreview | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data: run } = useLabImportRun(studyId, runId);
  const selectedMapping = mappings?.find((m) => m.id === (mappingId ?? mappings[0]?.id));
  const selectedId = selectedMapping?.id ?? null;

  async function onSaveMapping() {
    if (!editing) return;
    setError(null);
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(editing.json) as Record<string, unknown>;
    } catch {
      setError("Mapping config is not valid JSON.");
      return;
    }
    try {
      const saved = await saveMapping.mutateAsync({
        ...(editing.id ? { id: editing.id } : {}),
        name: editing.name,
        config,
      });
      setMappingId(saved.id);
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onFileChosen(chosen: File | undefined) {
    if (!chosen) return;
    setPreview(null);
    setRunId(null);
    setError(null);
    setFile({ name: chosen.name, content: await chosen.text() });
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onValidate() {
    if (!file || !selectedId) return;
    setError(null);
    setRunId(null);
    try {
      setPreview(await validate.mutateAsync({ mappingId: selectedId, content: file.content }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onExecute() {
    if (!file || !selectedId) return;
    setError(null);
    try {
      const result = await start.mutateAsync({
        mappingId: selectedId,
        content: file.content,
        fileName: file.name,
      });
      setRunId(result.runId);
      setConfirmName("");
      setPreview(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const wouldImport = preview ? (preview.counts.imported ?? 0) : 0;

  return (
    <div className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Lab data import
      </h2>
      <Card className="space-y-4 p-4">
        {isPending ? <Spinner /> : null}

        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
          {mappings && mappings.length > 0 ? (
            <>
              <span>Mapping</span>
              <select
                className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm"
                value={selectedId ?? ""}
                onChange={(e) => {
                  setMappingId(e.target.value);
                  setPreview(null);
                  setRunId(null);
                }}
              >
                {mappings.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {selectedMapping ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setEditing({
                      id: selectedMapping.id,
                      name: selectedMapping.name,
                      json: JSON.stringify(selectedMapping.config, null, 2),
                    })
                  }
                >
                  Edit
                </Button>
              ) : null}
            </>
          ) : (
            <span className="text-zinc-500">
              No mappings yet — a mapping tells the importer which CSV columns and test codes land
              on which form items.
            </span>
          )}
          <Button
            variant="secondary"
            onClick={() => setEditing({ name: "", json: CONFIG_TEMPLATE })}
          >
            New mapping
          </Button>
        </div>

        {editing ? (
          <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
            <input
              className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
              placeholder="Mapping name, e.g. Central Lab"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <textarea
              className="h-64 w-full rounded-lg border border-zinc-200 bg-white p-3 font-mono text-xs"
              value={editing.json}
              onChange={(e) => setEditing({ ...editing, json: e.target.value })}
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button
                onClick={onSaveMapping}
                disabled={editing.name === "" || saveMapping.isPending}
              >
                {saveMapping.isPending ? "Saving…" : "Save mapping"}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {selectedId ? (
          <div className="space-y-3 border-t border-zinc-100 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => onFileChosen(e.target.files?.[0])}
              />
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                Choose CSV…
              </Button>
              {file ? <span className="text-sm text-zinc-600">{file.name}</span> : null}
              <Button onClick={onValidate} disabled={!file || validate.isPending}>
                {validate.isPending ? "Validating…" : "Validate"}
              </Button>
            </div>

            {preview ? (
              <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
                <div className="text-sm text-zinc-700">
                  {preview.totalRows} row{preview.totalRows === 1 ? "" : "s"};{" "}
                  {preview.formsTouched} form{preview.formsTouched === 1 ? "" : "s"} touched,{" "}
                  {preview.formInstancesToCreate} to create. Nothing has been written yet.
                </div>
                <CountsTable counts={preview.counts} />
                <IssueList
                  issues={preview.issues}
                  truncatedNote={
                    preview.issuesTruncated ? "Only the first 200 issues are shown." : undefined
                  }
                />
                {wouldImport > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
                      placeholder={`Type "${studyName}" to confirm`}
                      value={confirmName}
                      onChange={(e) => setConfirmName(e.target.value)}
                    />
                    <Button
                      onClick={onExecute}
                      disabled={confirmName !== studyName || start.isPending}
                    >
                      {start.isPending
                        ? "Starting…"
                        : `Import ${wouldImport} row${wouldImport === 1 ? "" : "s"}`}
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500">No rows would import.</p>
                )}
              </div>
            ) : null}

            {run ? <RunReport run={run} /> : null}
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {runs && runs.length > 0 ? (
          <details className="border-t border-zinc-100 pt-3 text-sm text-zinc-700">
            <summary className="cursor-pointer text-zinc-500">Past imports ({runs.length})</summary>
            <ul className="mt-2 space-y-1">
              {runs.map((pastRun) => (
                <li key={pastRun.id} className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      pastRun.status === "completed"
                        ? "emerald"
                        : pastRun.status === "running"
                          ? "sky"
                          : "amber"
                    }
                  >
                    {pastRun.status.replace(/_/g, " ")}
                  </Badge>
                  <span>{new Date(pastRun.createdAt).toLocaleString()}</span>
                  <span className="text-zinc-400">{pastRun.fileName ?? "—"}</span>
                  <span>
                    {pastRun.counts.imported ?? 0} of {pastRun.totalRows} imported
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>
    </div>
  );
}
