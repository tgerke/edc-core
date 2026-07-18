import {
  addEvent,
  addForm,
  displayText,
  formsForEvent,
  type ItemGroupDef,
  listForms,
  type MetaDataVersion,
  resolveGroup,
  type ValidationIssue,
  validateMetaDataVersion,
} from "@edc-core/odm";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useImportOdm, usePermissions, useStudyBuild } from "../api/hooks.js";
import { FormEditor } from "../components/FormEditor.js";
import { FormPreview } from "../components/FormPreview.js";
import { RulesPanel } from "../components/RulesPanel.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

function EventTree({
  mdv,
  selected,
  editing,
  onSelect,
  onChange,
}: {
  mdv: MetaDataVersion;
  selected: string | null;
  editing: boolean;
  onSelect: (formOid: string) => void;
  onChange: (mdv: MetaDataVersion) => void;
}) {
  const allForms = listForms(mdv);
  const referencedByEvents = new Set(
    mdv.studyEventDefs.flatMap((e) => formsForEvent(mdv, e.oid).map((f) => f.oid)),
  );
  const unscheduledForms = allForms.filter((f) => !referencedByEvents.has(f.oid));

  const FormButton = ({ form }: { form: ItemGroupDef }) => (
    <button
      type="button"
      onClick={() => onSelect(form.oid)}
      className={`w-full rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
        selected === form.oid
          ? "bg-zinc-900 font-medium text-white"
          : "text-zinc-700 hover:bg-zinc-100"
      }`}
    >
      {form.name}
    </button>
  );

  const addFormTo = (eventOid: string) => {
    const result = addForm(mdv, { name: "New Form", eventOid });
    onChange(result.mdv);
    onSelect(result.formOid);
  };

  return (
    <nav className="space-y-4">
      {mdv.studyEventDefs.map((event) => (
        <div key={event.oid}>
          <div className="mb-1 flex items-center gap-2 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {event.name}
            </span>
            {event.repeating && event.repeating !== "No" ? <Badge tone="sky">repeats</Badge> : null}
          </div>
          <div className="space-y-0.5">
            {formsForEvent(mdv, event.oid).map((form) => (
              <FormButton key={form.oid} form={form} />
            ))}
            {editing ? (
              <button
                type="button"
                onClick={() => addFormTo(event.oid)}
                className="w-full rounded-lg px-3 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              >
                + form
              </button>
            ) : null}
          </div>
        </div>
      ))}
      {unscheduledForms.length > 0 ? (
        <div>
          <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Unscheduled forms
          </div>
          <div className="space-y-0.5">
            {unscheduledForms.map((form) => (
              <FormButton key={form.oid} form={form} />
            ))}
          </div>
        </div>
      ) : null}
      {editing ? (
        <button
          type="button"
          onClick={() => onChange(addEvent(mdv, { name: "New Event" }).mdv)}
          className="w-full rounded-lg px-3 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        >
          + event
        </button>
      ) : null}
    </nav>
  );
}

export function BuilderPage() {
  const { studyId, version } = useParams({ from: "/app/studies/$studyId/builds/$version" });
  const navigate = useNavigate();
  const { data: file, isPending, isError } = useStudyBuild(studyId, Number(version));
  const { data: permissions } = usePermissions(studyId);
  const importOdm = useImportOdm(studyId);
  const serverMdv = file?.study?.metaDataVersions[0];

  const [draft, setDraft] = useState<MetaDataVersion | null>(null);
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editing = draft !== null;
  const mdv = draft ?? serverMdv;
  const canEdit = permissions?.includes("study.manage") ?? false;

  const [selectedForm, setSelectedForm] = useState<string | null>(null);
  const forms = mdv ? listForms(mdv) : [];
  const activeFormOid =
    selectedForm && forms.some((f) => f.oid === selectedForm)
      ? selectedForm
      : (forms[0]?.oid ?? null);

  const resolved = useMemo(
    () => (mdv && activeFormOid ? resolveGroup(mdv, activeFormOid) : null),
    [mdv, activeFormOid],
  );

  const applyEdit = (next: MetaDataVersion) => {
    setDraft(next);
    setIssues([]);
    setSaveError(null);
  };

  const startEditing = () => {
    if (!serverMdv) return;
    setDraft(structuredClone(serverMdv));
    setNote(`Edited from build v${version}`);
  };

  const discard = () => {
    setDraft(null);
    setIssues([]);
    setSaveError(null);
  };

  const save = async () => {
    if (!draft || !file?.study) return;
    const found = validateMetaDataVersion(draft);
    const errors = found.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      setIssues(errors);
      return;
    }
    setIssues([]);
    setSaveError(null);
    const content = JSON.stringify({
      ...file,
      creationDateTime: new Date().toISOString(),
      sourceSystem: "edc-core",
      study: { ...file.study, metaDataVersions: [draft] },
    });
    try {
      const result = await importOdm.mutateAsync({ content, ...(note ? { note } : {}) });
      setDraft(null);
      navigate({
        to: "/studies/$studyId/builds/$version",
        params: { studyId, version: String(result.version) },
      });
    } catch (err) {
      setSaveError((err as Error).message);
    }
  };

  if (isPending) return <Spinner />;
  if (isError || !mdv) return <ErrorNote>Failed to load study build.</ErrorNote>;

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
      <div className="flex items-start justify-between gap-4">
        <PageTitle
          sub={
            <>
              {file?.study?.studyName} · build v{version} ·{" "}
              {displayText(mdv.description) ?? mdv.name ?? mdv.oid}
              {editing ? " · editing (unsaved)" : ""}
            </>
          }
        >
          Study builder
        </PageTitle>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Build note"
                className="w-56"
              />
              <Button variant="secondary" onClick={discard}>
                Discard
              </Button>
              <Button onClick={save} disabled={importOdm.isPending} className="whitespace-nowrap">
                {importOdm.isPending ? "Saving…" : "Save as new build"}
              </Button>
            </>
          ) : canEdit ? (
            <Button variant="secondary" onClick={startEditing}>
              Edit build
            </Button>
          ) : null}
        </div>
      </div>

      {issues.length > 0 ? (
        <div className="mb-4">
          <ErrorNote>
            <div className="font-medium">The draft has validation errors</div>
            <ul className="mt-1 list-inside list-disc">
              {issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          </ErrorNote>
        </div>
      ) : null}
      {saveError ? (
        <div className="mb-4">
          <ErrorNote>Save failed: {saveError}</ErrorNote>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit p-3">
          <EventTree
            mdv={mdv}
            selected={activeFormOid}
            editing={editing}
            onSelect={setSelectedForm}
            onChange={applyEdit}
          />
        </Card>
        <Card className="bg-zinc-50/50 p-6">
          {editing && activeFormOid ? (
            <FormEditor mdv={mdv} formOid={activeFormOid} onChange={applyEdit} />
          ) : resolved ? (
            <FormPreview form={resolved} />
          ) : (
            <div className="p-10 text-center text-sm text-zinc-500">
              Select a form to preview it.
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-6 p-6">
        <h2 className="mb-3 text-lg font-semibold text-zinc-900">Conditions &amp; methods</h2>
        <RulesPanel mdv={mdv} editing={editing} onChange={applyEdit} />
      </Card>
    </div>
  );
}
