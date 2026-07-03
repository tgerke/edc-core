import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useLogin } from "../api/hooks.js";
import { Button, Card, ErrorNote, Input } from "../components/ui.js";

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await login.mutateAsync({ username, password });
    await navigate({ to: "/studies" });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">edc-core</h1>
          <p className="mt-1 text-sm text-zinc-500">Sign in to continue</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="mb-1 block text-sm font-medium text-zinc-700">
              Username
            </label>
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-zinc-700">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {login.isError ? (
            <ErrorNote>
              {login.error.message === "locked"
                ? "Account locked after repeated failures. Try again later."
                : "Invalid username or password."}
            </ErrorNote>
          ) : null}
          <Button type="submit" className="w-full justify-center" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
