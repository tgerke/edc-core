import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useImportProtocol, useProtocolVersions, useStudies } from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";

/**
 * Entry point of the protocol-first build path: upload a USDM v4 JSON
 * protocol package; each upload becomes an immutable protocol version with
 * a compilation candidate to review and publish.
 */
export function ProtocolImportPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/protocol" });
  const navigate = useNavigate();
  const { data: studies } = useStudies();
  const { data: versions, isPending } = useProtocolVersions(studyId);
  const importProtocol = useImportProtocol(studyId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importIssues, setImportIssues] = useState<unknown[] | null>(null);

  const study = studies?.find((s) => s.id === studyId);

  async function onFileChosen(file: File | undefined) {
    if (!file) return;
    setImportIssues(null);
    const content = await file.text();
    try {
      const result = await importProtocol.mutateAsync({
        content,
        note: `Imported ${file.name}`,
      });
      navigate({
        to: "/studies/$studyId/protocol/$version",
        params: { studyId, version: String(result.version) },
      });
    } catch (err) {
      const issues = (err as { issues?: unknown[] }).issues;
      setImportIssues(issues ?? [{ message: (err as Error).message }]);
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <PageTitle
          sub={
            <>
              {study?.oid}
              {" · "}
              <Link to="/studies/$studyId" params={{ studyId }} className="underline">
                study builds
              </Link>
            </>
          }
        >
          Protocol ({study?.name ?? "Study"})
        </PageTitle>
        <div>
          <input
            ref={fileInput}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => onFileChosen(e.target.files?.[0])}
          />
          <Button onClick={() => fileInput.current?.click()} disabled={importProtocol.isPending}>
            {importProtocol.isPending ? "Importing…" : "Import USDM protocol"}
          </Button>
        </div>
      </div>

      <div className="mb-4 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-200">
        Upload a CDISC USDM v4 protocol package (JSON). Authoring in Excel? Convert the workbook
        with the usdm4-excel tool first — see the{" "}
        <a
          href="https://tgerke.github.io/edc-core/guide/protocol-import.html"
          className="underline"
          target="_blank"
          rel="noreferrer"
        >
          protocol import guide
        </a>
        .
      </div>

      {importIssues ? (
        <div className="mb-4">
          <ErrorNote>
            <div className="font-medium">USDM import failed</div>
            <ul className="mt-1 list-inside list-disc">
              {importIssues.map((issue, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static error list
                <li key={i}>
                  {typeof issue === "object" && issue !== null
                    ? `${(issue as { path?: string }).path ?? ""}: ${(issue as { message?: string }).message ?? ""}`
                    : String(issue)}
                </li>
              ))}
            </ul>
          </ErrorNote>
        </div>
      ) : null}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Protocol versions
      </h2>
      {isPending ? <Spinner /> : null}
      {versions && versions.length === 0 ? (
        <Card className="p-10 text-center text-sm text-zinc-500">
          No protocol versions yet. Import a USDM v4 JSON package to derive the study's data
          requirements from the protocol itself.
        </Card>
      ) : null}

      <div className="grid gap-3">
        {versions?.map((v) => (
          <Card key={v.id} className="flex items-center gap-4 p-4">
            <Badge tone="sky">protocol v{v.version}</Badge>
            <span className="text-xs text-zinc-500">USDM {v.usdmVersion}</span>
            <div className="text-sm text-zinc-700">{v.note ?? "—"}</div>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-zinc-400">
                {new Date(v.createdAt).toLocaleString()}
              </span>
              <Link
                to="/studies/$studyId/protocol/$version"
                params={{ studyId, version: String(v.version) }}
              >
                <Button variant="secondary">Review</Button>
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
