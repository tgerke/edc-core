import { type FormEvent, useState } from "react";
import {
  type AdminUser,
  useAdminUsers,
  useCreateUser,
  useMe,
  useSetSystemAdmin,
  useUserAction,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

function statusTone(user: AdminUser): "emerald" | "amber" | "zinc" {
  if (user.status === "deactivated") return "zinc";
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) return "amber";
  return "emerald";
}

function statusLabel(user: AdminUser): string {
  if (user.status === "deactivated") return "deactivated";
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) return "locked";
  return "active";
}

function CreateUserForm({ onCredential }: { onCredential: (c: Credential) => void }) {
  const createUser = useCreateUser();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [auth, setAuth] = useState<"password" | "sso">("password");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const created = await createUser.mutateAsync({ username, email, fullName, auth });
      if (created.temporaryPassword) {
        onCredential({
          username: created.username,
          password: created.temporaryPassword,
          context: "created",
        });
      }
      setUsername("");
      setEmail("");
      setFullName("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <Input
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          placeholder="Full name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
        />
        <select
          className="rounded-lg border border-zinc-200 bg-white px-2 py-2 text-sm"
          value={auth}
          onChange={(e) => setAuth(e.target.value as "password" | "sso")}
        >
          <option value="password">Local password (generated)</option>
          <option value="sso">SSO (no local password)</option>
        </select>
        <Button type="submit" disabled={createUser.isPending}>
          {createUser.isPending ? "Creating…" : "Create user"}
        </Button>
        {error ? (
          <div className="w-full">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

interface Credential {
  username: string;
  password: string;
  context: "created" | "reset";
}

export function AdminUsersPage() {
  const { data: me } = useMe();
  const { data: users, isPending } = useAdminUsers();
  const deactivate = useUserAction("deactivate");
  const reactivate = useUserAction("reactivate");
  const unlock = useUserAction("unlock");
  const resetPassword = useUserAction("reset-password");
  const setSystemAdmin = useSetSystemAdmin();

  const [credential, setCredential] = useState<Credential | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      <PageTitle sub="Accounts are deactivated, never deleted — signatures stay attributable.">
        Users
      </PageTitle>

      <div className="mb-4">
        <CreateUserForm onCredential={setCredential} />
      </div>

      {credential ? (
        <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
          <div className="font-medium">
            Temporary password for “{credential.username}” — share it securely now; it will not be
            shown again, and they must replace it at first sign-in.
          </div>
          <code className="mt-1 block select-all break-all font-mono text-xs">
            {credential.password}
          </code>
          <Button variant="ghost" onClick={() => setCredential(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {isPending ? <Spinner /> : null}

      <div className="grid gap-2">
        {users?.map((user) => (
          <Card key={user.id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
            <Badge tone={statusTone(user)}>{statusLabel(user)}</Badge>
            <div>
              <span className="font-medium text-zinc-900">{user.fullName}</span>{" "}
              <span className="text-zinc-500">({user.username})</span>
            </div>
            <span className="text-zinc-400">{user.email}</span>
            {user.isSystemAdmin ? <Badge tone="sky">system admin</Badge> : null}
            {user.ssoLinked || !user.hasPassword ? <Badge tone="zinc">SSO</Badge> : null}
            {user.mustChangePassword ? <Badge tone="amber">temp password</Badge> : null}
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {user.id === me?.id ? (
                <span className="text-xs text-zinc-400">(you)</span>
              ) : (
                <>
                  {statusLabel(user) === "locked" ? (
                    <Button variant="ghost" onClick={() => act(() => unlock.mutateAsync(user.id))}>
                      Unlock
                    </Button>
                  ) : null}
                  {user.hasPassword && user.status !== "deactivated" ? (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        act(async () => {
                          const result = await resetPassword.mutateAsync(user.id);
                          if (result.temporaryPassword) {
                            setCredential({
                              username: user.username,
                              password: result.temporaryPassword,
                              context: "reset",
                            });
                          }
                        })
                      }
                    >
                      Reset password
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      act(() =>
                        setSystemAdmin.mutateAsync({
                          userId: user.id,
                          isSystemAdmin: !user.isSystemAdmin,
                        }),
                      )
                    }
                  >
                    {user.isSystemAdmin ? "Remove admin" : "Make admin"}
                  </Button>
                  {user.status === "deactivated" ? (
                    <Button
                      variant="ghost"
                      onClick={() => act(() => reactivate.mutateAsync(user.id))}
                    >
                      Reactivate
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => act(() => deactivate.mutateAsync(user.id))}
                    >
                      Deactivate
                    </Button>
                  )}
                </>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
