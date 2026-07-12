import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useCreateStudy, useMe, useStudies } from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

const statusTone = { design: "amber", active: "emerald", locked: "sky", archived: "zinc" } as const;

function CreateStudyForm({ onDone }: { onDone: () => void }) {
  const createStudy = useCreateStudy();
  const [oid, setOid] = useState("");
  const [name, setName] = useState("");
  const [protocolName, setProtocolName] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await createStudy.mutateAsync({
      oid,
      name,
      ...(protocolName ? { protocolName } : {}),
    });
    onDone();
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_2fr_1fr_auto]">
        <Input
          placeholder="OID (e.g. ST.001)"
          value={oid}
          onChange={(e) => setOid(e.target.value)}
          required
        />
        <Input
          placeholder="Study name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          placeholder="Protocol (optional)"
          value={protocolName}
          onChange={(e) => setProtocolName(e.target.value)}
        />
        <Button type="submit" disabled={createStudy.isPending}>
          Create
        </Button>
        {createStudy.isError ? (
          <div className="sm:col-span-4">
            <ErrorNote>{createStudy.error.message}</ErrorNote>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

export function StudiesPage() {
  const { data: studies, isPending, isError } = useStudies();
  const { data: me } = useMe();
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="flex items-start justify-between">
        <PageTitle sub="Studies you are a member of">Studies</PageTitle>
        {me?.isSystemAdmin ? (
          <div className="flex items-center gap-2">
            <Link to="/admin/users">
              <Button variant="ghost">Users</Button>
            </Link>
            <Link to="/admin/dictionaries">
              <Button variant="ghost">Dictionaries</Button>
            </Link>
            <Button variant="secondary" onClick={() => setCreating((v) => !v)}>
              {creating ? "Cancel" : "New study"}
            </Button>
          </div>
        ) : null}
      </div>

      {creating ? (
        <div className="mb-4">
          <CreateStudyForm onDone={() => setCreating(false)} />
        </div>
      ) : null}

      {isPending ? <Spinner /> : null}
      {isError ? <ErrorNote>Failed to load studies.</ErrorNote> : null}

      {studies && studies.length === 0 ? (
        <Card className="p-10 text-center text-sm text-zinc-500">
          No studies yet.{" "}
          {me?.isSystemAdmin ? "Create one to get started." : "Ask an administrator for access."}
        </Card>
      ) : null}

      <div className="grid gap-3">
        {studies?.map((study) => (
          <Link key={study.id} to="/studies/$studyId/subjects" params={{ studyId: study.id }}>
            <Card className="flex items-center gap-4 p-5 transition-shadow hover:shadow-md">
              <div>
                <div className="font-medium text-zinc-900">{study.name}</div>
                <div className="mt-0.5 font-mono text-xs text-zinc-400">{study.oid}</div>
              </div>
              <div className="ml-auto flex items-center gap-3">
                {study.protocolName ? (
                  <span className="text-sm text-zinc-500">{study.protocolName}</span>
                ) : null}
                <Badge tone={statusTone[study.status as keyof typeof statusTone] ?? "zinc"}>
                  {study.status}
                </Badge>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
