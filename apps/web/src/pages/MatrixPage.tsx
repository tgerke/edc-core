import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  type MatrixCell,
  useEnrollSubject,
  useEnsureForm,
  useMatrix,
  usePermissions,
  useSites,
  useStudies,
} from "../api/hooks.js";
import { Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

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

function EnrollForm({ studyId, onDone }: { studyId: string; onDone: () => void }) {
  const { data: sites } = useSites(studyId);
  const enroll = useEnrollSubject(studyId);
  const [siteId, setSiteId] = useState("");
  const [subjectKey, setSubjectKey] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await enroll.mutateAsync({ siteId, subjectKey });
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
        <Button type="submit" disabled={enroll.isPending}>
          Enroll
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
                  <td className="px-4 py-2.5 font-medium text-zinc-900">{subject.subjectKey}</td>
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
