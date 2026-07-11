import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  type CodingItem,
  type CodingRunRow,
  useAssignCoding,
  useClearCoding,
  useCodingItems,
  useCodingRun,
  useCodingRuns,
  useCodingSearch,
  useCodingSettings,
  usePermissions,
  useSaveDictionaryBinding,
  useStartCodingRun,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

const STATUS_FILTERS = ["all", "uncoded", "stale", "coded_auto", "coded_manual"] as const;
const STATUS_LABEL: Record<string, string> = {
  uncoded: "uncoded",
  stale: "stale",
  coded_auto: "coded (auto)",
  coded_manual: "coded (manual)",
};
const STATUS_TONE: Record<string, "zinc" | "emerald" | "amber" | "sky"> = {
  uncoded: "zinc",
  stale: "amber",
  coded_auto: "sky",
  coded_manual: "emerald",
};

const RUN_STATUS_TONE: Record<CodingRunRow["status"], "zinc" | "emerald" | "amber" | "sky"> = {
  running: "sky",
  completed: "emerald",
  completed_with_errors: "amber",
  failed: "amber",
};

/** Occurrence key — one expandable row per codable verbatim occurrence. */
function itemKey(item: CodingItem): string {
  return `${item.formInstanceId}:${item.itemGroupOid}:${item.itemGroupRepeatKey}:${item.itemOid}`;
}

function CurrentCodingCell({ item }: { item: CodingItem }) {
  if (!item.coding) return <span className="text-zinc-400">—</span>;
  const detail =
    item.dictionaryType === "MedDRA"
      ? [item.coding.ptTerm ? `PT ${item.coding.ptTerm}` : null, item.coding.socTerm]
      : [item.coding.atcCode ? `ATC ${item.coding.atcCode}` : null, item.coding.atcText];
  return (
    <div>
      <div className="text-zinc-800">
        <span className="font-mono text-[11px] text-zinc-400">{item.coding.code}</span>{" "}
        {item.coding.term}
      </div>
      <div className="text-xs text-zinc-500">{detail.filter(Boolean).join(" · ")}</div>
    </div>
  );
}

function CodingWorkPanel({
  studyId,
  item,
  onDone,
}: {
  studyId: string;
  item: CodingItem;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useCodingSearch(studyId, item.dictionaryType, query);
  const assign = useAssignCoding(studyId);
  const clear = useClearCoding(studyId);
  const occurrence = {
    formInstanceId: item.formInstanceId,
    itemGroupOid: item.itemGroupOid,
    itemGroupRepeatKey: item.itemGroupRepeatKey,
    itemOid: item.itemOid,
  };

  return (
    <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-4">
      {item.status === "stale" && item.coding ? (
        <p className="mb-3 text-sm text-amber-700">
          Coded as {item.coding.code} ({item.coding.term}) against the previous verbatim "
          {item.coding.verbatim}" — the value is now "{item.verbatim}"; confirm or recode.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          placeholder={`Search ${item.dictionaryType} terms…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
        />
        {item.coding ? (
          <Button
            variant="secondary"
            disabled={clear.isPending}
            onClick={async () => {
              await clear.mutateAsync(occurrence);
              onDone();
            }}
          >
            Clear coding
          </Button>
        ) : null}
      </div>
      {assign.isError ? (
        <div className="mt-2">
          <ErrorNote>{assign.error.message}</ErrorNote>
        </div>
      ) : null}
      {clear.isError ? (
        <div className="mt-2">
          <ErrorNote>{clear.error.message}</ErrorNote>
        </div>
      ) : null}
      {search.data && search.data.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No matching terms.</p>
      ) : null}
      {search.data && search.data.length > 0 ? (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
          {search.data.map((term) => (
            <li key={term.id} className="flex items-center gap-3 px-3 py-2">
              <span className="font-mono text-[11px] text-zinc-400">{term.code}</span>
              <span className="text-sm text-zinc-800">{term.term}</span>
              <span className="text-xs text-zinc-500">
                {item.dictionaryType === "MedDRA"
                  ? [term.ptTerm ? `PT ${term.ptTerm}` : null, term.socTerm]
                      .filter(Boolean)
                      .join(" · ")
                  : [term.atcCode ? `ATC ${term.atcCode}` : null, term.atcText]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
              <Button
                className="ml-auto"
                variant="secondary"
                disabled={assign.isPending}
                onClick={async () => {
                  await assign.mutateAsync({ ...occurrence, termId: term.id });
                  onDone();
                }}
              >
                Assign
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function BindingControls({ studyId, canManage }: { studyId: string; canManage: boolean }) {
  const { data: settings } = useCodingSettings(studyId);
  const save = useSaveDictionaryBinding(studyId);
  if (!settings) return null;

  const types = ["MedDRA", "WHODrug"] as const;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {types.map((type) => {
        const binding = settings.bindings.find((b) => b.dictionaryType === type);
        const options = settings.availableDictionaries.filter((d) => d.type === type);
        if (!canManage) {
          return (
            <span key={type} className="text-zinc-500">
              {type}: {binding ? binding.version : "not bound"}
            </span>
          );
        }
        return (
          <label key={type} className="flex items-center gap-1.5 text-zinc-600">
            {type}
            <select
              value={binding?.dictionaryId ?? ""}
              onChange={(e) =>
                save.mutate({ dictionaryType: type, dictionaryId: e.target.value || null })
              }
              className="rounded-lg border border-zinc-300 px-2 py-1 text-sm"
            >
              <option value="">not bound</option>
              {options.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.version} ({d.termsCount.toLocaleString()} terms)
                </option>
              ))}
            </select>
          </label>
        );
      })}
      {save.isError ? <ErrorNote>{save.error.message}</ErrorNote> : null}
    </div>
  );
}

function RunStatusLine({ studyId, runId }: { studyId: string; runId: string | null }) {
  const { data: runs } = useCodingRuns(studyId);
  const latestId = runId ?? runs?.[0]?.id ?? null;
  const { data: run } = useCodingRun(studyId, latestId);
  if (!run) return null;

  const counts = Object.entries(run.counts)
    .map(([outcome, n]) => `${outcome.replaceAll("_", " ")}: ${n}`)
    .join(" · ");
  return (
    <div className="mt-2 text-sm text-zinc-600">
      <Badge tone={RUN_STATUS_TONE[run.status]}>{run.status.replaceAll("_", " ")}</Badge>{" "}
      {run.status === "running"
        ? `${run.processedOccurrences} / ${run.totalOccurrences} occurrences`
        : counts || "nothing to code"}
      {run.issues.length > 0 && run.status !== "running" ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-zinc-500">
            {run.issues.length} issue{run.issues.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-0.5 text-xs text-zinc-500">
            {run.issues.slice(0, 8).map((issue) => (
              <li key={`${issue.subjectKey}:${issue.itemOid}:${issue.verbatim}`}>
                {issue.subjectKey} · "{issue.verbatim}" — {issue.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function CodingPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/coding" });
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [type, setType] = useState<"all" | "MedDRA" | "WHODrug">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const { data: permissions } = usePermissions(studyId);
  const canCode = (permissions ?? []).includes("data.code");
  const canManage = (permissions ?? []).includes("study.manage");
  const { data: items, isPending, isError } = useCodingItems(studyId, status, type);
  const startRun = useStartCodingRun(studyId);

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle sub="Verbatim terms from coding-flagged items, coded against the study's dictionaries.">
          Medical coding
        </PageTitle>
        <div className="text-right">
          <div className="flex items-center justify-end gap-3">
            <BindingControls studyId={studyId} canManage={canManage} />
            {canCode ? (
              <Button
                disabled={startRun.isPending}
                onClick={async () => {
                  const res = await startRun.mutateAsync();
                  setRunId(res.runId);
                }}
              >
                Run auto-coding
              </Button>
            ) : null}
          </div>
          {startRun.isError ? (
            <div className="mt-2">
              <ErrorNote>{startRun.error.message}</ErrorNote>
            </div>
          ) : null}
          <RunStatusLine studyId={studyId} runId={runId} />
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1">
        {STATUS_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatus(value)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              status === value
                ? "bg-zinc-900 font-medium text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {value === "all" ? "all" : STATUS_LABEL[value]}
          </button>
        ))}
        <span className="mx-1 self-center text-zinc-300">|</span>
        {(["all", "MedDRA", "WHODrug"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setType(value)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              type === value
                ? "bg-zinc-900 font-medium text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {value === "all" ? "both dictionaries" : value}
          </button>
        ))}
      </div>

      {isPending ? <Spinner /> : null}
      {isError ? <ErrorNote>Failed to load coding items.</ErrorNote> : null}
      {items && items.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Nothing to code{status === "all" ? "" : ` with status ${STATUS_LABEL[status]}`}. Items
          appear here when a study build flags them with a coding dictionary and sites enter values.
        </p>
      ) : null}
      {items && items.length > 0 ? (
        <Card>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Verbatim</th>
                <th className="px-4 py-3 font-medium">Dictionary</th>
                <th className="px-4 py-3 font-medium">Current coding</th>
                <th className="px-4 py-3 font-medium">Subject</th>
                <th className="px-4 py-3 font-medium">Form</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {items.map((item) => {
                const key = itemKey(item);
                const isExpanded = expanded === key;
                return [
                  <tr
                    key={key}
                    className={`hover:bg-zinc-50 ${canCode ? "cursor-pointer" : ""}`}
                    onClick={() => canCode && setExpanded(isExpanded ? null : key)}
                  >
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[item.status] ?? "zinc"}>
                        {STATUS_LABEL[item.status] ?? item.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-medium text-zinc-800">{item.verbatim}</td>
                    <td className="px-4 py-3 text-zinc-600">{item.dictionaryType}</td>
                    <td className="px-4 py-3">
                      <CurrentCodingCell item={item} />
                    </td>
                    <td className="px-4 py-3 text-zinc-600">{item.subjectKey}</td>
                    <td className="px-4 py-3">
                      <Link
                        to="/forms/$formInstanceId"
                        params={{ formInstanceId: item.formInstanceId }}
                        className="text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {item.formOid}
                      </Link>
                    </td>
                  </tr>,
                  isExpanded ? (
                    <tr key={`${key}:panel`}>
                      <td colSpan={6} className="p-0">
                        <CodingWorkPanel
                          studyId={studyId}
                          item={item}
                          onDone={() => setExpanded(null)}
                        />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
