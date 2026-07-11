import { blankMetaDataVersion } from "@edc-core/odm";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useImportOdm, useMetadataVersions, usePermissions, useStudies } from "../api/hooks.js";
import { AmendmentsPanel } from "../components/AmendmentsPanel.js";
import { LabImportPanel } from "../components/LabImportPanel.js";
import { RtsmPanel } from "../components/RtsmPanel.js";
import { Badge, Button, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";

export function StudyPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId" });
  const navigate = useNavigate();
  const { data: studies } = useStudies();
  const { data: versions, isPending } = useMetadataVersions(studyId);
  const { data: permissions } = usePermissions(studyId);
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

  async function startFromScratch() {
    if (!study) return;
    setImportIssues(null);
    setWarnings([]);
    const content = JSON.stringify({
      fileOid: `${study.oid}.builder`,
      fileType: "Snapshot",
      odmVersion: "2.0",
      creationDateTime: new Date().toISOString(),
      granularity: "Metadata",
      sourceSystem: "edc-core",
      study: {
        oid: study.oid,
        studyName: study.name,
        ...(study.protocolName ? { protocolName: study.protocolName } : {}),
        metaDataVersions: [blankMetaDataVersion(study.name)],
      },
    });
    try {
      const result = await importOdm.mutateAsync({ content, note: "Started in study builder" });
      navigate({
        to: "/studies/$studyId/builds/$version",
        params: { studyId, version: String(result.version) },
      });
    } catch (err) {
      const issues = (err as { issues?: unknown[] }).issues;
      setImportIssues(issues ?? [{ message: (err as Error).message }]);
    }
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
              {" · "}
              <Link to="/studies/$studyId/queries" params={{ studyId }} className="underline">
                queries
              </Link>
              {" · "}
              <Link to="/studies/$studyId/coding" params={{ studyId }} className="underline">
                coding
              </Link>
              {" · "}
              <Link to="/studies/$studyId/audit" params={{ studyId }} className="underline">
                audit trail
              </Link>
              {" · "}
              <Link to="/studies/$studyId/workbench" params={{ studyId }} className="underline">
                analytics
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
          <div className="font-medium">
            Imported with {warnings.length} warning{warnings.length === 1 ? "" : "s"}
          </div>
          <ul className="mt-1 list-inside list-disc">
            {warnings.slice(0, 8).map((warning, i) => {
              const w = warning as { path?: string; message?: string };
              // biome-ignore lint/suspicious/noArrayIndexKey: static warning list
              return <li key={i}>{w.path ? `${w.path}: ${w.message ?? ""}` : String(warning)}</li>;
            })}
            {warnings.length > 8 ? <li>…and {warnings.length - 8} more</li> : null}
          </ul>
        </div>
      ) : null}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Study builds
      </h2>
      {isPending ? <Spinner /> : null}
      {versions && versions.length === 0 ? (
        <Card className="p-10 text-center text-sm text-zinc-500">
          <p>
            No study builds yet. Import a CDISC ODM v2.0 file (XML or JSON) to create version 1,
          </p>
          <p className="mt-2">
            or{" "}
            <Button variant="secondary" onClick={startFromScratch} disabled={importOdm.isPending}>
              start point-and-click in the builder
            </Button>
          </p>
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

      {versions && versions.length >= 2 ? (
        <AmendmentsPanel
          studyId={studyId}
          studyName={study?.name ?? ""}
          versions={versions}
          canManage={(permissions ?? []).includes("study.manage")}
        />
      ) : null}

      {versions && versions.length >= 1 && (permissions ?? []).includes("data.import") ? (
        <LabImportPanel studyId={studyId} studyName={study?.name ?? ""} />
      ) : null}

      {versions && versions.length >= 1 && (permissions ?? []).includes("study.manage") ? (
        <RtsmPanel studyId={studyId} />
      ) : null}
    </div>
  );
}
