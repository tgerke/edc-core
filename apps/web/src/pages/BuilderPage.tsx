import {
  displayText,
  formsForEvent,
  type ItemGroupDef,
  listForms,
  type MetaDataVersion,
  resolveGroup,
} from "@edc-core/odm";
import { Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useStudyBuild } from "../api/hooks.js";
import { FormPreview } from "../components/FormPreview.js";
import { Badge, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";

function EventTree({
  mdv,
  selected,
  onSelect,
}: {
  mdv: MetaDataVersion;
  selected: string | null;
  onSelect: (formOid: string) => void;
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
    </nav>
  );
}

export function BuilderPage() {
  const { studyId, version } = useParams({ from: "/app/studies/$studyId/builds/$version" });
  const { data: file, isPending, isError } = useStudyBuild(studyId, Number(version));
  const mdv = file?.study?.metaDataVersions[0];

  const [selectedForm, setSelectedForm] = useState<string | null>(null);
  const firstForm = mdv ? (listForms(mdv)[0]?.oid ?? null) : null;
  const activeFormOid = selectedForm ?? firstForm;

  const resolved = useMemo(
    () => (mdv && activeFormOid ? resolveGroup(mdv, activeFormOid) : null),
    [mdv, activeFormOid],
  );

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
      <PageTitle
        sub={
          <>
            {file?.study?.studyName} · build v{version} ·{" "}
            {displayText(mdv.description) ?? mdv.name ?? mdv.oid}
          </>
        }
      >
        Study builder
      </PageTitle>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit p-3">
          <EventTree mdv={mdv} selected={activeFormOid} onSelect={setSelectedForm} />
        </Card>
        <Card className="bg-zinc-50/50 p-6">
          {resolved ? (
            <FormPreview form={resolved} />
          ) : (
            <div className="p-10 text-center text-sm text-zinc-500">
              Select a form to preview it.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
