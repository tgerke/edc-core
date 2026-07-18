import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  type SiteVariantDefinition,
  useCreateVariant,
  useEnsureForm,
  useMatrix,
  useSaveVariantVersion,
  useSites,
  useSiteVariants,
  useSubmitVariantVersion,
  useValidateVariant,
  type VariantIssue,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

const STATUS_TONES: Record<string, "zinc" | "emerald" | "amber" | "sky"> = {
  draft: "zinc",
  submitted: "sky",
  approved: "emerald",
  changes_requested: "amber",
  retired: "zinc",
  stale: "amber",
};

/**
 * BYOFW: the site's own view of its form layouts. Variants start as a copy
 * of the sponsor's standard layout, get regrouped/reordered/relabeled here,
 * and go to the sponsor for approval. The live validator keeps every edit
 * data-equivalent — the site shapes the workflow, never the data.
 */
export function SiteFormsPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/site-forms" });
  const { data: sites } = useSites(studyId);
  const [siteId, setSiteId] = useState("");
  const effectiveSiteId = siteId || sites?.[0]?.id || "";

  return (
    <div>
      <PageTitle
        sub={
          <>
            <Link to="/studies/$studyId" params={{ studyId }} className="underline">
              study
            </Link>
            {" · "}
            <Link to="/studies/$studyId/subjects" params={{ studyId }} className="underline">
              subjects
            </Link>
          </>
        }
      >
        Site form layouts
      </PageTitle>

      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm text-zinc-600">Site</span>
        <select
          value={effectiveSiteId}
          onChange={(e) => setSiteId(e.target.value)}
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
        >
          {(sites ?? []).map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
      </div>

      {effectiveSiteId ? <SiteVariantsPanel studyId={studyId} siteId={effectiveSiteId} /> : null}
    </div>
  );
}

function SiteVariantsPanel({ studyId, siteId }: { studyId: string; siteId: string }) {
  const { data: variants, isPending, isError, error } = useSiteVariants(studyId, siteId);
  const createVariant = useCreateVariant(studyId, siteId);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  if (isPending) return <Spinner />;
  if (isError) {
    return (
      <ErrorNote>
        {(error as Error).message === "missing permission: site.forms.manage"
          ? "You don't hold site.forms.manage for this site."
          : (error as Error).message}
      </ErrorNote>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-4">
        <Input
          placeholder="New layout name (e.g. Clinic workflow)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          disabled={name.trim() === "" || createVariant.isPending}
          onClick={async () => {
            setCreateError(null);
            try {
              await createVariant.mutateAsync({ name: name.trim() });
              setName("");
            } catch (err) {
              setCreateError((err as Error).message);
            }
          }}
        >
          {createVariant.isPending ? "Creating…" : "Start from standard layout"}
        </Button>
        <p className="w-full text-xs text-zinc-500">
          A new layout copies the sponsor's standard forms; adapt it to your clinic's flow, then
          submit it for sponsor approval. The data collected never changes — only how your forms
          present it.
        </p>
        {createError ? <ErrorNote>{createError}</ErrorNote> : null}
      </Card>

      {(variants ?? []).length === 0 ? (
        <Card className="p-8 text-center text-sm text-zinc-500">No site layouts yet.</Card>
      ) : null}

      {(variants ?? []).map((variant) => (
        <VariantEditor key={variant.id} studyId={studyId} siteId={siteId} variant={variant} />
      ))}

      <VariantCaptureLauncher studyId={studyId} siteId={siteId} />
    </div>
  );
}

function VariantEditor({
  studyId,
  siteId,
  variant,
}: {
  studyId: string;
  siteId: string;
  variant: NonNullable<ReturnType<typeof useSiteVariants>["data"]>[number];
}) {
  const save = useSaveVariantVersion(studyId, siteId, variant.id);
  const submit = useSubmitVariantVersion(studyId, siteId);
  const validate = useValidateVariant(studyId, siteId);
  const [draft, setDraft] = useState<SiteVariantDefinition | null>(null);
  const [issues, setIssues] = useState<VariantIssue[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const latest = variant.latest;
  if (!latest) return null;
  const definition = draft ?? latest.definition;
  const editable = latest.status === "draft" || latest.status === "changes_requested";

  async function revalidate(next: SiteVariantDefinition) {
    setDraft(next);
    try {
      const result = await validate.mutateAsync({ definition: next });
      setIssues(result.issues);
    } catch {
      // validation surface only; save still reports issues
    }
  }

  function moveItem(eventIndex: number, formIndex: number, itemIndex: number, delta: -1 | 1) {
    const next = structuredClone(definition);
    const refs = next.events[eventIndex]?.forms[formIndex]?.sections[0]?.itemRefs;
    if (!refs) return;
    const target = itemIndex + delta;
    if (target < 0 || target >= refs.length) return;
    const [moved] = refs.splice(itemIndex, 1);
    if (!moved) return;
    refs.splice(target, 0, moved);
    refs.forEach((ref, i) => {
      ref.orderNumber = i + 1;
    });
    void revalidate(next);
  }

  function relabelItem(eventIndex: number, formIndex: number, itemIndex: number, label: string) {
    const next = structuredClone(definition);
    const ref = next.events[eventIndex]?.forms[formIndex]?.sections[0]?.itemRefs[itemIndex];
    if (!ref) return;
    if (label.trim() === "") delete ref.displayLabel;
    else ref.displayLabel = label;
    void revalidate(next);
  }

  function renameForm(eventIndex: number, formIndex: number, formName: string) {
    const next = structuredClone(definition);
    const form = next.events[eventIndex]?.forms[formIndex];
    if (!form) return;
    form.name = formName;
    void revalidate(next);
  }

  const errors = issues.filter((i) => i.severity === "error");

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">{variant.name}</h3>
        <Badge tone={STATUS_TONES[latest.status] ?? "zinc"}>{latest.status}</Badge>
        <span className="text-xs text-zinc-400">v{latest.version}</span>
        {latest.decisionNote ? (
          <span className="text-xs text-zinc-500">sponsor: “{latest.decisionNote}”</span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {editable && draft ? (
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={async () => {
                setActionError(null);
                try {
                  const result = await save.mutateAsync({ definition });
                  setIssues(result.issues);
                  setDraft(null);
                } catch (err) {
                  setActionError((err as Error).message);
                }
              }}
            >
              {save.isPending ? "Saving…" : "Save draft"}
            </Button>
          ) : null}
          {editable && !draft ? (
            <Button
              disabled={submit.isPending || errors.length > 0}
              onClick={async () => {
                setActionError(null);
                try {
                  await submit.mutateAsync(latest.id);
                } catch (err) {
                  setActionError((err as Error).message);
                }
              }}
            >
              {submit.isPending ? "Submitting…" : "Submit for approval"}
            </Button>
          ) : null}
        </div>
      </div>

      {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
      {errors.length > 0 ? (
        <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200">
          <div className="font-medium">Not data-equivalent yet</div>
          <ul className="mt-1 list-inside list-disc">
            {errors.slice(0, 6).map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 ring-1 ring-emerald-200">
          Data-equivalent to the sponsor's standard layout.
        </div>
      )}

      {definition.events.map((event, eventIndex) => (
        <div key={event.eventOid} className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {event.eventOid}
          </div>
          {event.forms.map((form, formIndex) => (
            <div key={form.oid} className="rounded-lg border border-zinc-200 p-3">
              <div className="mb-2 flex items-center gap-2">
                {editable ? (
                  <Input
                    value={form.name}
                    onChange={(e) => renameForm(eventIndex, formIndex, e.target.value)}
                  />
                ) : (
                  <span className="text-sm font-medium text-zinc-800">{form.name}</span>
                )}
                <span className="font-mono text-[11px] text-zinc-400">{form.oid}</span>
              </div>
              <ul className="space-y-1">
                {(form.sections[0]?.itemRefs ?? []).map((ref, itemIndex) => (
                  <li key={ref.itemOid} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-[11px] text-zinc-400">{ref.itemOid}</span>
                    {editable ? (
                      <input
                        className="w-56 rounded border border-zinc-200 px-2 py-1 text-xs"
                        placeholder="Relabel for your site (optional)"
                        value={ref.displayLabel ?? ""}
                        onChange={(e) =>
                          relabelItem(eventIndex, formIndex, itemIndex, e.target.value)
                        }
                      />
                    ) : ref.displayLabel ? (
                      <span className="text-xs text-zinc-600">“{ref.displayLabel}”</span>
                    ) : null}
                    {ref.mandatory ? <span className="text-rose-500">*</span> : null}
                    {editable ? (
                      <span className="ml-auto flex gap-1">
                        <Button
                          variant="ghost"
                          onClick={() => moveItem(eventIndex, formIndex, itemIndex, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => moveItem(eventIndex, formIndex, itemIndex, 1)}
                        >
                          ↓
                        </Button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

/** Start capture for a subject at this site through the approved layout. */
function VariantCaptureLauncher({ studyId, siteId }: { studyId: string; siteId: string }) {
  const { data: matrix } = useMatrix(studyId);
  const { data: variants } = useSiteVariants(studyId, siteId);
  const navigate = useNavigate();
  const ensureForm = useEnsureForm();
  const [launchError, setLaunchError] = useState<string | null>(null);

  const approved = (variants ?? [])
    .map((variant) => variant.latest)
    .find((latest) => latest?.status === "approved");
  if (!approved) return null;

  const siteSubjects = (matrix?.subjects ?? []).filter((subject) => subject.siteId === siteId);
  if (siteSubjects.length === 0) return null;

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-zinc-900">Capture through your layout</h3>
      {launchError ? <ErrorNote>{launchError}</ErrorNote> : null}
      <div className="grid gap-2">
        {approved.definition.events.map((event) =>
          event.forms.map((form) => (
            <div key={`${event.eventOid}:${form.oid}`} className="flex items-center gap-2 text-sm">
              <Badge tone="sky">{event.eventOid}</Badge>
              <span className="text-zinc-800">{form.name}</span>
              <select
                className="ml-auto rounded border border-zinc-200 px-2 py-1 text-xs"
                defaultValue=""
                onChange={async (e) => {
                  const subjectId = e.target.value;
                  if (!subjectId) return;
                  setLaunchError(null);
                  try {
                    const instance = await ensureForm.mutateAsync({
                      subjectId,
                      eventOid: event.eventOid,
                      formOid: form.oid,
                    });
                    navigate({
                      to: "/forms/$formInstanceId",
                      params: { formInstanceId: instance.id },
                    });
                  } catch (err) {
                    setLaunchError((err as Error).message);
                  }
                }}
              >
                <option value="">Open for subject…</option>
                {siteSubjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.subjectKey}
                  </option>
                ))}
              </select>
            </div>
          )),
        )}
      </div>
    </Card>
  );
}
