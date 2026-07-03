import { Link, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useImportOdm, useMetadataVersions, useStudies } from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";

export function StudyPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId" });
  const { data: studies } = useStudies();
  const { data: versions, isPending } = useMetadataVersions(studyId);
  const importOdm = useImportOdm(studyId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importIssues, setImportIssues] = useState<unknown[] | null>(null);
  const [warnings, setWarnings] = useState<unknown[]>([]);

  const study = studies?.find((s) => s.id === studyId);

  async function onFileChosen(file: File | undefined) {
    if (!file) return;
    setImportIssues(null);
    setWarnings([]);
    const content = await file.text();
    try {
      const result = await importOdm.mutateAsync({ content, note: `Imported ${file.name}` });
      setWarnings(result.warnings);
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
              <Link to="/studies/$studyId/subjects" params={{ studyId }} className="underline">
                subjects
              </Link>
            </>
          }
        >
          {study?.name ?? "Study"}
        </PageTitle>
        <div>
          <input
            ref={fileInput}
            type="file"
            accept=".xml,.json"
            className="hidden"
            onChange={(e) => onFileChosen(e.target.files?.[0])}
          />
          <Button onClick={() => fileInput.current?.click()} disabled={importOdm.isPending}>
            {importOdm.isPending ? "Importing…" : "Import ODM"}
          </Button>
        </div>
      </div>

      {importIssues ? (
        <div className="mb-4">
          <ErrorNote>
            <div className="font-medium">ODM import failed</div>
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
      {warnings.length > 0 ? (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          Imported with {warnings.length} warning{warnings.length === 1 ? "" : "s"} (unreferenced
          definitions are kept but unused).
        </div>
      ) : null}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Study builds
      </h2>
      {isPending ? <Spinner /> : null}
      {versions && versions.length === 0 ? (
        <Card className="p-10 text-center text-sm text-zinc-500">
          No study builds yet. Import a CDISC ODM v2.0 file (XML or JSON) to create version 1 — or
          build point-and-click in a future release.
        </Card>
      ) : null}

      <div className="grid gap-3">
        {versions?.map((v) => (
          <Card key={v.id} className="flex items-center gap-4 p-4">
            <Badge tone="sky">v{v.version}</Badge>
            <div className="text-sm text-zinc-700">{v.note ?? "—"}</div>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-zinc-400">
                {new Date(v.createdAt).toLocaleString()}
              </span>
              <a
                href={`/api/studies/${studyId}/metadata-versions/${v.version}/odm?serialization=xml`}
                download
              >
                <Button variant="ghost">XML</Button>
              </a>
              <a
                href={`/api/studies/${studyId}/metadata-versions/${v.version}/odm?serialization=json`}
                download
              >
                <Button variant="ghost">JSON</Button>
              </a>
              <Link
                to="/studies/$studyId/builds/$version"
                params={{ studyId, version: String(v.version) }}
              >
                <Button variant="secondary">Open builder</Button>
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
