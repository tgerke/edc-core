import { useState } from "react";
import {
  type MetadataVersionSummary,
  type MigrationImpact,
  useAnalyzeMigration,
  useBuildDiff,
  useMigrationRun,
  useStartMigration,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote } from "./ui.js";

const KIND_TONE: Record<string, "emerald" | "amber" | "zinc"> = {
  added: "emerald",
  removed: "amber",
  changed: "zinc",
};

function DiffSection({
  title,
  entries,
}: {
  title: string;
  entries: { kind: string; detail?: string | undefined; label: string; key: string }[];
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h4>
      <ul className="mt-1 space-y-1">
        {entries.map((entry) => (
          <li key={entry.key} className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
            <Badge tone={KIND_TONE[entry.kind] ?? "zinc"}>{entry.kind}</Badge>
            <span className="font-medium">{entry.label}</span>
            {entry.detail ? <span className="text-zinc-500">— {entry.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImpactReport({ impact }: { impact: MigrationImpact }) {
  const excludedTotal = impact.excluded.signed + impact.excluded.locked;
  return (
    <div className="space-y-2 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700 ring-1 ring-zinc-200">
      <div>
        <span className="font-medium">{impact.eligible.total}</span> form
        {impact.eligible.total === 1 ? "" : "s"} will migrate (
        {Object.entries(impact.eligible.byStatus)
          .map(([status, count]) => `${count} ${status.replace("_", " ")}`)
          .join(", ") || "none"}
        ).
      </div>
      {excludedTotal > 0 ? (
        <div className="rounded-md bg-violet-50 px-2 py-1 text-violet-800 ring-1 ring-violet-200">
          {impact.excluded.signed} signed and {impact.excluded.locked} locked form
          {excludedTotal === 1 ? " keeps" : "s keep"} the build they were signed/locked under —
          re-signing after an amendment is a deliberate, separate act.
        </div>
      ) : null}
      {impact.orphanedValues.length > 0 ? (
        <div className="rounded-md bg-amber-50 px-2 py-1 text-amber-800 ring-1 ring-amber-200">
          <div className="font-medium">Values orphaned by removed items</div>
          <ul className="mt-1 list-inside list-disc">
            {impact.orphanedValues.map((orphan) => (
              <li key={`${orphan.itemGroupOid}:${orphan.itemOid}`}>
                {orphan.itemOid} ({orphan.itemGroupOid}): {orphan.valueCount} value
                {orphan.valueCount === 1 ? "" : "s"} — kept in the audit trail, no longer rendered
                or exported
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {impact.typeConflicts.length > 0 ? (
        <div className="rounded-md bg-rose-50 px-2 py-1 text-rose-800 ring-1 ring-rose-200">
          <div className="font-medium">Data type conflicts</div>
          <ul className="mt-1 list-inside list-disc">
            {impact.typeConflicts.map((conflict) => (
              <li key={`${conflict.itemGroupOid}:${conflict.itemOid}`}>
                {conflict.itemOid}: {conflict.nonCastableCount} value
                {conflict.nonCastableCount === 1 ? "" : "s"} will not cast {conflict.from} →{" "}
                {conflict.to}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {impact.checksAddedOrChanged.length > 0 ? (
        <div>
          Checks added or changed ({impact.checksAddedOrChanged.join(", ")}) re-run on migration:
          expect new system queries where they fire.
        </div>
      ) : null}
    </div>
  );
}

export function AmendmentsPanel({
  studyId,
  studyName,
  versions,
  canManage,
}: {
  studyId: string;
  studyName: string;
  versions: MetadataVersionSummary[];
  canManage: boolean;
}) {
  const versionNumbers = versions.map((v) => v.version).sort((a, b) => b - a);
  const latest = versionNumbers[0] ?? null;
  const [fromVersion, setFromVersion] = useState<number | null>(versionNumbers[1] ?? null);
  const target = latest;

  const { data: diffData } = useBuildDiff(studyId, fromVersion, target);
  const analyze = useAnalyzeMigration(studyId);
  const start = useStartMigration(studyId);
  const [runId, setRunId] = useState<string | null>(null);
  const { data: run } = useMigrationRun(studyId, runId);
  const [confirmName, setConfirmName] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (versionNumbers.length < 2) return null;

  const diff = diffData?.diff;
  const impact = analyze.data;
  const progress = run ? run.processedForms + run.skippedForms + run.failedForms : 0;

  async function onAnalyze() {
    setError(null);
    setRunId(null);
    try {
      if (target !== null) await analyze.mutateAsync(target);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onExecute() {
    setError(null);
    try {
      if (target !== null) {
        const result = await start.mutateAsync(target);
        setRunId(result.runId);
        setConfirmName("");
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Amendments
      </h2>
      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
          <span>Compare</span>
          <select
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm"
            value={fromVersion ?? ""}
            onChange={(e) => {
              setFromVersion(Number(e.target.value));
              analyze.reset();
              setRunId(null);
            }}
          >
            {versionNumbers
              .filter((v) => v !== target)
              .map((v) => (
                <option key={v} value={v}>
                  v{v}
                </option>
              ))}
          </select>
          <span>
            against the current build <Badge tone="sky">v{target}</Badge> — in-flight forms migrate
            to the current build.
          </span>
        </div>

        {diff && !diff.hasChanges ? (
          <p className="text-sm text-zinc-500">No differences between these builds.</p>
        ) : null}
        {diff?.hasChanges ? (
          <div className="grid gap-3 md:grid-cols-2">
            <DiffSection
              title="Items"
              entries={diff.items.map((item) => ({
                kind: item.kind,
                label: `${item.name} (${item.itemOid})`,
                detail: item.changes ? Object.keys(item.changes).join(", ") : undefined,
                key: `${item.itemGroupOid}:${item.itemOid}:${item.kind}`,
              }))}
            />
            <DiffSection
              title="Edit checks"
              entries={diff.editChecks.map((check) => ({
                kind: check.kind,
                label: check.name,
                detail: check.detail,
                key: check.oid,
              }))}
            />
            <DiffSection
              title="Events & forms"
              entries={[...diff.events, ...diff.forms].map((entry) => ({
                kind: entry.kind,
                label: entry.name,
                detail: entry.detail,
                key: entry.oid,
              }))}
            />
            <DiffSection
              title="Codelists & groups"
              entries={[...diff.codeLists, ...diff.itemGroups].map((entry) => ({
                kind: entry.kind,
                label: entry.name,
                detail: entry.detail,
                key: entry.oid,
              }))}
            />
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {canManage ? (
          <div className="space-y-3 border-t border-zinc-100 pt-3">
            <Button variant="secondary" onClick={onAnalyze} disabled={analyze.isPending}>
              {analyze.isPending ? "Analyzing…" : "Analyze impact"}
            </Button>
            {impact ? <ImpactReport impact={impact} /> : null}
            {impact && impact.eligible.total > 0 && !runId ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
                  placeholder={`Type "${studyName}" to confirm`}
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                />
                <Button onClick={onExecute} disabled={confirmName !== studyName || start.isPending}>
                  {start.isPending
                    ? "Starting…"
                    : `Migrate ${impact.eligible.total} form${impact.eligible.total === 1 ? "" : "s"} to v${target}`}
                </Button>
              </div>
            ) : null}
            {run ? (
              <div className="space-y-1 text-sm text-zinc-700">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      run.status === "completed"
                        ? "emerald"
                        : run.status === "running"
                          ? "sky"
                          : "amber"
                    }
                  >
                    {run.status.replace(/_/g, " ")}
                  </Badge>
                  <span>
                    {progress} of {run.totalForms} forms ({run.processedForms} migrated,{" "}
                    {run.skippedForms} skipped, {run.failedForms} failed)
                  </span>
                </div>
                <div className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-all"
                    style={{
                      width: `${run.totalForms === 0 ? 100 : Math.round((progress / run.totalForms) * 100)}%`,
                    }}
                  />
                </div>
                {run.errors.length > 0 ? (
                  <ErrorNote>
                    <ul className="list-inside list-disc">
                      {run.errors.slice(0, 5).map((entry) => (
                        <li key={entry.formInstanceId}>
                          {entry.formInstanceId}: {entry.message}
                        </li>
                      ))}
                    </ul>
                  </ErrorNote>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
