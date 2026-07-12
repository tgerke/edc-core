import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  type StudyMember,
  type UserMatch,
  useGrantRole,
  useMe,
  usePermissions,
  useRevokeGrant,
  useRoles,
  useSites,
  useStudies,
  useStudyMembers,
  useUserSearch,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";

function GrantForm({ studyId }: { studyId: string }) {
  const { data: roleCatalog } = useRoles();
  const { data: sites } = useSites(studyId);
  const grantRole = useGrantRole(studyId);

  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<UserMatch | null>(null);
  const [roleName, setRoleName] = useState("");
  const [siteId, setSiteId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: matches } = useUserSearch(studyId, picked ? "" : query);

  async function onGrant() {
    if (!picked || roleName === "") return;
    setError(null);
    try {
      await grantRole.mutateAsync({
        userId: picked.id,
        roleName,
        ...(siteId ? { siteId } : {}),
      });
      setPicked(null);
      setQuery("");
      setRoleName("");
      setSiteId("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
        <span className="font-medium">Grant a role</span>
        {picked ? (
          <span className="flex items-center gap-1 rounded-lg bg-zinc-100 px-2 py-1">
            {picked.fullName} <span className="text-zinc-400">({picked.username})</span>
            <Button variant="ghost" onClick={() => setPicked(null)}>
              ×
            </Button>
          </span>
        ) : (
          <input
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
            placeholder="Find a user (name, username, email)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <select
          className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
          value={roleName}
          onChange={(e) => setRoleName(e.target.value)}
        >
          <option value="">Role…</option>
          {roleCatalog?.map((role) => (
            <option key={role.name} value={role.name} title={role.description}>
              {role.name}
            </option>
          ))}
        </select>
        <select
          className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
        >
          <option value="">All sites (study-wide)</option>
          {sites?.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name} ({site.oid})
            </option>
          ))}
        </select>
        <Button onClick={onGrant} disabled={!picked || roleName === "" || grantRole.isPending}>
          {grantRole.isPending ? "Granting…" : "Grant"}
        </Button>
      </div>
      {!picked && matches && matches.length > 0 ? (
        <ul className="max-w-md divide-y divide-zinc-100 rounded-lg bg-zinc-50 text-sm ring-1 ring-zinc-200">
          {matches.map((match) => (
            <li key={match.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-100"
                onClick={() => setPicked(match)}
              >
                <span className="font-medium text-zinc-900">{match.fullName}</span>
                <span className="text-zinc-500">{match.username}</span>
                <span className="ml-auto text-xs text-zinc-400">{match.email}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!picked && query.trim().length >= 2 && matches && matches.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No matching account — create one under Users (system administrators).
        </p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </Card>
  );
}

export function TeamPage() {
  const { studyId } = useParams({ from: "/app/studies/$studyId/team" });
  const { data: studies } = useStudies();
  const { data: me } = useMe();
  const { data: members, isPending } = useStudyMembers(studyId);
  const { data: permissions } = usePermissions(studyId);
  const revoke = useRevokeGrant(studyId);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const study = studies?.find((s) => s.id === studyId);
  const canGrant = (permissions ?? []).includes("roles.grant") || me?.isSystemAdmin === true;

  async function onRevoke(member: StudyMember) {
    // Revoking your own last grant locks you out of the study; make the
    // second click deliberate.
    if (member.userId === me?.id && confirmRevoke !== member.grantId) {
      setConfirmRevoke(member.grantId);
      return;
    }
    setConfirmRevoke(null);
    setError(null);
    try {
      await revoke.mutateAsync(member.grantId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <PageTitle sub={`${study?.oid ?? ""} · study team and role grants`}>
        {study?.name ?? "Study"} — team
      </PageTitle>

      {canGrant ? (
        <div className="mb-4">
          <GrantForm studyId={studyId} />
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {isPending ? <Spinner /> : null}

      <div className="grid gap-2">
        {members?.map((member) => (
          <Card key={member.grantId} className="flex flex-wrap items-center gap-3 p-4 text-sm">
            <div>
              <span className="font-medium text-zinc-900">{member.fullName}</span>{" "}
              <span className="text-zinc-500">({member.username})</span>
            </div>
            <Badge tone="sky">{member.roleName}</Badge>
            <Badge tone={member.siteId ? "zinc" : "emerald"}>
              {member.siteId ? `${member.siteName} (${member.siteOid})` : "study-wide"}
            </Badge>
            {member.userStatus !== "active" ? (
              <Badge tone="amber">{member.userStatus}</Badge>
            ) : null}
            <span className="text-xs text-zinc-400">
              granted {new Date(member.grantedAt).toLocaleDateString()} by {member.grantedBy}
            </span>
            {canGrant ? (
              <div className="ml-auto">
                <Button variant="ghost" onClick={() => onRevoke(member)}>
                  {confirmRevoke === member.grantId ? "Revoke my own grant?" : "Revoke"}
                </Button>
              </div>
            ) : null}
          </Card>
        ))}
        {members && members.length === 0 ? (
          <Card className="p-10 text-center text-sm text-zinc-500">No role grants yet.</Card>
        ) : null}
      </div>
    </div>
  );
}
