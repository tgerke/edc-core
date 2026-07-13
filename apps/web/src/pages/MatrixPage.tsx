import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  type MatrixCell,
  useBreakBlind,
  useEnrollSubject,
  useEnsureForm,
  useMatrix,
  usePermissions,
  useSites,
  useStudies,
  useTransitionSubject,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

export const STATUS_STYLES: Record<string, string> = {
  empty: "bg-zinc-50 text-zinc-400 ring-zinc-200",
  not_started: "bg-zinc-100 text-zinc-500 ring-zinc-200",
  in_progress: "bg-sky-50 text-sky-700 ring-sky-200",
  complete: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  verified: "bg-teal-50 text-teal-700 ring-teal-200",
  signed: "bg-violet-50 text-violet-700 ring-violet-200",
  locked: "bg-zinc-200 text-zinc-600 ring-zinc-300",
};

export function statusLabel(status: string): string {
  return status.replace("_", " ");
}

const SUBJECT_STATUS_TONES: Record<string, "amber" | "emerald" | "sky" | "zinc"> = {
  screening: "amber",
  enrolled: "emerald",
  completed: "sky",
  withdrawn: "zinc",
  screen_failed: "zinc",
};

// Mirrors SUBJECT_TRANSITIONS server-side; the server is authoritative.
const SUBJECT_ACTIONS: Record<string, Array<{ action: string; label: string; reason: boolean }>> = {
  screening: [
    { action: "enroll", label: "Enroll", reason: false },
    { action: "screen_fail", label: "Screen fail…", reason: true },
  ],
  enrolled: [
    { action: "complete", label: "Complete", reason: false },
    { action: "withdraw", label: "Withdraw…", reason: true },
  ],
  screen_failed: [{ action: "reinstate", label: "Reinstate…", reason: true }],
  completed: [{ action: "reinstate", label: "Reinstate…", reason: true }],
  withdrawn: [{ action: "reinstate", label: "Reinstate…", reason: true }],
};

// Mirrors UNBLINDING_CATEGORIES server-side (E6(R3) §4.1.4 taxonomy).
const UNBLIND_CATEGORIES = ["emergency", "inadvertent", "planned", "other"] as const;
const UNBLIND_ACTION = "unblind";

function SubjectLifecycle({
  studyId,
  subjectId,
  subjectKey,
  status,
  unblinded,
  canTransition,
  canUnblind,
}: {
  studyId: string;
  subjectId: string;
  subjectKey: string;
  status: string;
  unblinded: boolean;
  canTransition: boolean;
  canUnblind: boolean;
}) {
  const transition = useTransitionSubject(studyId);
  const breakBlind = useBreakBlind(studyId);
  const [pending, setPending] = useState<{ action: string; label: string } | null>(null);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<string>("emergency");
  const [error, setError] = useState<string | null>(null);
  const busy = transition.isPending || breakBlind.isPending;
  const actions = [
    ...(canTransition ? (SUBJECT_ACTIONS[status] ?? []) : []),
    // The documented break-the-blind event; always available, repeatable.
    ...(canUnblind ? [{ action: UNBLIND_ACTION, label: "Break the blind…", reason: true }] : []),
  ];

  function reset() {
    setPending(null);
    setReason("");
    setCategory("emergency");
    setError(null);
  }

  async function run(action: string, withReason?: string) {
    setError(null);
    try {
      if (action === UNBLIND_ACTION) {
        await breakBlind.mutateAsync({ subjectId, category, reason: withReason ?? "" });
      } else {
        await transition.mutateAsync({
          subjectId,
          action,
          ...(withReason ? { reason: withReason } : {}),
        });
      }
      reset();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-medium text-zinc-900">{subjectKey}</span>
        <Badge tone={SUBJECT_STATUS_TONES[status] ?? "zinc"}>{statusLabel(status)}</Badge>
        {unblinded ? <Badge tone="amber">unblinded</Badge> : null}
        {actions.length > 0 && !pending ? (
          <select
            className="rounded-md border border-zinc-200 bg-white px-1 py-0.5 text-xs text-zinc-500"
            value=""
            onChange={(e) => {
              const chosen = actions.find((a) => a.action === e.target.value);
              if (!chosen) return;
              if (chosen.reason) setPending({ action: chosen.action, label: chosen.label });
              else void run(chosen.action);
            }}
            disabled={busy}
            title={`Change status of ${subjectKey}`}
          >
            <option value="">…</option>
            {actions.map((a) => (
              <option key={a.action} value={a.action}>
                {a.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {pending ? (
        <div className="flex items-center gap-1">
          {pending.action === UNBLIND_ACTION ? (
            <select
              className="rounded-md border border-zinc-200 bg-white px-1 py-1 text-xs"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              title="Unblinding category"
            >
              {UNBLIND_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : null}
          <input
            className="w-40 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
            placeholder={
              pending.action === UNBLIND_ACTION
                ? "Reason for unblinding"
                : `Reason to ${statusLabel(pending.action)}`
            }
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => run(pending.action, reason)}
            disabled={reason.trim() === "" || busy}
          >
            {pending.label.replace("…", "")}
          </Button>
          <Button variant="ghost" onClick={reset}>
            Cancel
          </Button>
        </div>
      ) : null}
      {error ? <div className="text-xs text-amber-700">{error}</div> : null}
    </div>
  );
}

function EnrollForm({ studyId, onDone }: { studyId: string; onDone: () => void }) {
  const { data: sites } = useSites(studyId);
  const enroll = useEnrollSubject(studyId);
  const [siteId, setSiteId] = useState("");
  const [subjectKey, setSubjectKey] = useState("");
  const [status, setStatus] = useState<"enrolled" | "screening">("enrolled");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await enroll.mutateAsync({ siteId, subjectKey, status });
    onDone();
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-3">
        <select
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          required
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
        >
          <option value="">Select site…</option>
          {sites?.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name} ({site.oid})
            </option>
          ))}
        </select>
        <div className="w-48">
          <Input
            placeholder="Subject key (e.g. 001-001)"
            value={subjectKey}
            onChange={(e) => setSubjectKey(e.target.value)}
            required
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as "enrolled" | "screening")}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
        >
          <option value="enrolled">Enrolled</option>
          <option value="screening">Screening</option>
        </select>
        <Button type="submit" disabled={enroll.isPending}>
          {status === "screening" ? "Register" : "Enroll"}
        </Button>
        {enroll.isError ? <ErrorNote>{enroll.error.message}</ErrorNote> : null}
      </form>
    </Card>
  );
}

function MatrixCellButton({
  cell,
  subjectId,
  eventOid,
  formOid,
}: {
  cell: MatrixCell | null;
  subjectId: string;
  eventOid: string;
  formOid: string;
}) {
  const ensureForm = useEnsureForm();
  const navigate = useNavigate();
  const status = cell?.status ?? "empty";

  async function open() {
    const formInstanceId =
      cell?.formInstanceId ?? (await ensureForm.mutateAsync({ subjectId, eventOid, formOid })).id;
    await navigate({ to: "/forms/$formInstanceId", params: { formInstanceId } });
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={ensureForm.isPending}
      className={`w-full rounded-md px-2 py-1.5 text-xs font-medium ring-1 transition-shadow hover:shadow ${STATUS_STYLES[status] ?? STATUS_STYLES.empty}`}
      title={`${formOid}: ${statusLabel(status)}`}
    >
      {status === "empty" ? "—" : statusLabel(status)}
    </button>
  );
}

export function MatrixPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/subjects" });
  const { data: studies } = useStudies();
  const { data: matrix, isPending, isError } = useMatrix(studyId);
  const { data: permissions } = usePermissions(studyId);
  const [enrolling, setEnrolling] = useState(false);
  const study = studies?.find((s) => s.id === studyId);
  const canExport = permissions?.includes("export.data") ?? false;
  const canEnroll = permissions?.includes("subject.enroll") ?? false;
  const canUnblind = permissions?.includes("data.unblind") ?? false;

  if (isPending) return <Spinner />;
  if (isError || !matrix) return <ErrorNote>Failed to load the subject matrix.</ErrorNote>;

  const columns = matrix.events.flatMap((event) => event.forms.map((form) => ({ event, form })));

  return (
    <div>
      <div className="flex items-start justify-between">
        <PageTitle
          sub={
            <>
              {study?.oid}
              {matrix.buildVersion ? <> · capturing on build v{matrix.buildVersion}</> : null}
              {" · "}
              <Link to="/studies/$studyId" params={{ studyId }} className="underline">
                study builds
              </Link>
            </>
          }
        >
          {study?.name ?? "Subjects"}
        </PageTitle>
        <Button variant="secondary" onClick={() => setEnrolling((v) => !v)}>
          {enrolling ? "Cancel" : "Enroll subject"}
        </Button>
      </div>

      {enrolling ? (
        <div className="mb-4">
          <EnrollForm studyId={studyId} onDone={() => setEnrolling(false)} />
        </div>
      ) : null}

      {matrix.buildVersion === null ? (
        <Card className="p-10 text-center text-sm text-zinc-500">
          No study build published yet — import an ODM file first.
        </Card>
      ) : matrix.subjects.length === 0 ? (
        <Card className="p-10 text-center text-sm text-zinc-500">No subjects enrolled yet.</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-3 font-semibold">Subject</th>
                <th className="px-4 py-3 font-semibold">Site</th>
                {columns.map(({ event, form }) => (
                  <th key={`${event.oid}:${form.oid}`} className="px-3 py-3 font-semibold">
                    <div>{event.name}</div>
                    <div className="font-normal normal-case text-zinc-400">{form.name}</div>
                  </th>
                ))}
                {canExport ? <th className="px-3 py-3" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {matrix.subjects.map((subject) => (
                <tr key={subject.id}>
                  <td className="px-4 py-2.5">
                    <SubjectLifecycle
                      studyId={studyId}
                      subjectId={subject.id}
                      subjectKey={subject.subjectKey}
                      status={subject.status}
                      unblinded={subject.unblinded}
                      canTransition={canEnroll}
                      canUnblind={canUnblind}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500">{subject.siteName}</td>
                  {columns.map(({ event, form }) => (
                    <td key={`${event.oid}:${form.oid}`} className="px-3 py-2.5">
                      <MatrixCellButton
                        cell={subject.cells[`${event.oid}:${form.oid}`] ?? null}
                        subjectId={subject.id}
                        eventOid={event.oid}
                        formOid={form.oid}
                      />
                    </td>
                  ))}
                  {canExport ? (
                    <td className="px-3 py-2.5">
                      <a
                        href={`/api/subjects/${subject.id}/casebook`}
                        download
                        className="whitespace-nowrap text-xs text-zinc-500 underline hover:text-zinc-800"
                        title={`Download the PDF casebook for ${subject.subjectKey}`}
                      >
                        casebook
                      </a>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
