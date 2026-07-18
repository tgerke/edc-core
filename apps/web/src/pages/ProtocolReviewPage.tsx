import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  type ProtocolConceptStatus,
  useProtocolVersion,
  usePublishCompilation,
  useResolveDraftItems,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

/**
 * The protocol review workspace: the schedule of activities as the protocol
 * defines it (encounters × activities), each activity's biomedical concepts
 * with resolution status, and a completion flow for draft items. Publishing
 * is enabled once nothing is left unresolved.
 */
export function ProtocolReviewPage() {
  const { studyId, version } = useParams({ from: "/app/studies/$studyId/protocol/$version" });
  const navigate = useNavigate();
  const { data: detail, isPending } = useProtocolVersion(studyId, version);
  const resolveDrafts = useResolveDraftItems(studyId, version);
  const publish = usePublishCompilation(studyId, version);
  const [resolvingItem, setResolvingItem] = useState<{
    itemOid: string;
    conceptName: string;
  } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  if (isPending) return <Spinner />;
  if (!detail) return <ErrorNote>Protocol version not found.</ErrorNote>;

  const soa = detail.soa;
  const compilation = detail.compilation;
  const published = compilation?.status === "published";
  const unresolvedCount = compilation?.unresolvedCount ?? 0;

  async function onPublish() {
    setPublishError(null);
    try {
      const result = await publish.mutateAsync();
      navigate({
        to: "/studies/$studyId/builds/$version",
        params: { studyId, version: String(result.buildVersion) },
      });
    } catch (err) {
      setPublishError((err as Error).message);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <PageTitle
          sub={
            <>
              USDM {detail.usdmVersion}
              {" · "}
              <Link to="/studies/$studyId/protocol" params={{ studyId }} className="underline">
                protocol versions
              </Link>
              {" · "}
              <Link to="/studies/$studyId" params={{ studyId }} className="underline">
                study builds
              </Link>
            </>
          }
        >
          Protocol v{detail.version} review
        </PageTitle>
        <div className="flex items-center gap-3">
          {published ? (
            <Badge tone="emerald">published</Badge>
          ) : (
            <>
              <span className="text-sm text-zinc-500">
                {unresolvedCount === 0
                  ? "All concepts resolved"
                  : `${unresolvedCount} draft item${unresolvedCount === 1 ? "" : "s"} to complete`}
              </span>
              <Button onClick={onPublish} disabled={unresolvedCount > 0 || publish.isPending}>
                {publish.isPending ? "Publishing…" : "Publish build"}
              </Button>
            </>
          )}
        </div>
      </div>

      {publishError ? (
        <div className="mb-4">
          <ErrorNote>{publishError}</ErrorNote>
        </div>
      ) : null}

      {soa ? (
        <Card className="overflow-x-auto p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4">Activity</th>
                {soa.encounters.map((encounter) => (
                  <th key={encounter.usdmId} className="px-3 py-2 text-center">
                    <div>{encounter.label}</div>
                    {encounter.timingLabel ? (
                      <div className="font-normal normal-case text-zinc-400">
                        {encounter.timingLabel}
                        {encounter.windowLabel ? ` (${encounter.windowLabel})` : ""}
                      </div>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {soa.rows.map((row) => (
                <tr key={row.usdmId} className="border-t border-zinc-100">
                  <td className="py-2 pr-4">
                    {row.isGroupHeading ? (
                      <span className="font-semibold text-zinc-800">{row.label}</span>
                    ) : (
                      <div>
                        <div className="text-zinc-800">{row.label}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {row.concepts.map((concept) => (
                            <ConceptBadge
                              key={concept.usdmId}
                              concept={concept}
                              published={published}
                              onResolve={(itemOid) =>
                                setResolvingItem({ itemOid, conceptName: concept.name })
                              }
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </td>
                  {soa.encounters.map((encounter) => (
                    <td key={encounter.usdmId} className="px-3 py-2 text-center">
                      {row.encounterIds.includes(encounter.usdmId) ? (
                        <span role="img" aria-label="scheduled" className="text-zinc-700">
                          ●
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <ErrorNote>No compilation available for this protocol version.</ErrorNote>
      )}

      {soa && soa.warnings.length > 0 ? (
        <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          <div className="font-medium">Manual follow-ups from compilation</div>
          <ul className="mt-1 list-inside list-disc">
            {soa.warnings.map((warning) => (
              <li key={`${warning.path}:${warning.message}`}>
                {warning.path}: {warning.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {resolvingItem ? (
        <ResolveDraftDialog
          conceptName={resolvingItem.conceptName}
          itemOid={resolvingItem.itemOid}
          busy={resolveDrafts.isPending}
          onCancel={() => setResolvingItem(null)}
          onSubmit={async (resolution) => {
            await resolveDrafts.mutateAsync({ resolutions: [resolution] });
            setResolvingItem(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ConceptBadge({
  concept,
  published,
  onResolve,
}: {
  concept: ProtocolConceptStatus;
  published: boolean;
  onResolve: (itemOid: string) => void;
}) {
  if (concept.status === "resolved") {
    return (
      <Badge tone="emerald">
        {concept.name}
        {concept.conceptCode ? ` (${concept.conceptCode})` : ""}
      </Badge>
    );
  }
  const draftOid = concept.itemOids[0];
  return (
    <button
      type="button"
      disabled={published || !draftOid}
      onClick={() => draftOid && onResolve(draftOid)}
      className="cursor-pointer disabled:cursor-default"
      title="Draft item — click to complete"
    >
      <Badge tone="amber">
        {concept.name} — draft{concept.kind === "surrogate" ? " (surrogate)" : ""}
      </Badge>
    </button>
  );
}

function ResolveDraftDialog({
  conceptName,
  itemOid,
  busy,
  onCancel,
  onSubmit,
}: {
  conceptName: string;
  itemOid: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (resolution: {
    itemOid: string;
    name: string;
    question: string;
    dataType: string;
    mandatory: boolean;
    codeListTerms?: { codedValue: string; decode?: string }[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [question, setQuestion] = useState(conceptName);
  const [dataType, setDataType] = useState("text");
  const [mandatory, setMandatory] = useState(false);
  const [terms, setTerms] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-zinc-900/40 p-4">
      <Card className="w-full max-w-lg p-6">
        <h3 className="text-base font-semibold text-zinc-900">Complete draft item</h3>
        <p className="mt-1 text-sm text-zinc-500">
          The protocol names <span className="font-medium">{conceptName}</span> without a full data
          definition ({itemOid}). Define how it is captured.
        </p>
        {error ? (
          <div className="mt-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
        <div className="mt-4 grid gap-3">
          <div className="grid gap-1 text-sm">
            <label htmlFor="draft-item-name" className="text-zinc-600">
              Item name (short, e.g. AETERM)
            </label>
            <Input id="draft-item-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1 text-sm">
            <label htmlFor="draft-item-question" className="text-zinc-600">
              Question shown to sites
            </label>
            <Input
              id="draft-item-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>
          <label className="grid gap-1 text-sm">
            <span className="text-zinc-600">Data type</span>
            <select
              value={dataType}
              onChange={(e) => setDataType(e.target.value)}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
            >
              {["text", "integer", "float", "date", "datetime", "boolean"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-zinc-600">
              Codelist terms (optional, one per line: CODE=Label)
            </span>
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={3}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
              placeholder={"NORMAL=Normal\nABNORMAL=Abnormal"}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-600">
            <input
              type="checkbox"
              checked={mandatory}
              onChange={(e) => setMandatory(e.target.checked)}
            />
            Required at data entry
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || name.trim() === "" || question.trim() === ""}
            onClick={async () => {
              setError(null);
              const codeListTerms = terms
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [codedValue, decode] = line.split("=", 2);
                  return {
                    codedValue: (codedValue ?? "").trim(),
                    ...(decode ? { decode: decode.trim() } : {}),
                  };
                })
                .filter((t) => t.codedValue !== "");
              try {
                await onSubmit({
                  itemOid,
                  name: name.trim(),
                  question: question.trim(),
                  dataType,
                  mandatory,
                  ...(codeListTerms.length > 0 ? { codeListTerms } : {}),
                });
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
