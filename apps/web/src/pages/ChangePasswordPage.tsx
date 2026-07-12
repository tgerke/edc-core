import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useChangePassword, useMe } from "../api/hooks.js";
import { Button, Card, ErrorNote, Input, PageTitle } from "../components/ui.js";

export function ChangePasswordPage() {
  const { data: me } = useMe();
  const changePassword = useChangePassword();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const forced = me?.mustChangePassword ?? false;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError("New passwords do not match.");
      return;
    }
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      await navigate({ to: "/studies" });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (me && !me.hasPassword) {
    return (
      <div>
        <PageTitle>Change password</PageTitle>
        <Card className="p-5 text-sm text-zinc-600">
          This account signs in through your organization's identity provider; there is no local
          password to change.
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle
        {...(forced
          ? {
              sub: "Your password was issued by an administrator. Set your own before continuing — nothing else is accessible until you do.",
            }
          : {})}
      >
        Change password
      </PageTitle>
      <Card className="max-w-md p-5">
        <form onSubmit={onSubmit} className="grid gap-3">
          <Input
            type="password"
            placeholder={forced ? "Temporary password" : "Current password"}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <Input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <Input
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
          <Button type="submit" disabled={changePassword.isPending}>
            {changePassword.isPending ? "Saving…" : "Change password"}
          </Button>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </form>
      </Card>
    </div>
  );
}
