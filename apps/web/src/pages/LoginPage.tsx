import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useAuthConfig, useLogin } from "../api/hooks.js";
import { Button, Card, ErrorNote, Input, Spinner } from "../components/ui.js";

const OIDC_ERRORS: Record<string, string> = {
  oidc_state: "The sign-in attempt expired. Please try again.",
  oidc_exchange: "Sign-in with your identity provider failed. Please try again.",
  oidc_provision:
    "Sign-in succeeded but your account could not be set up. Contact an administrator.",
  missing_email: "Your identity provider did not share an email address, which is required.",
  deactivated: "Your account has been deactivated.",
};

export function LoginPage() {
  const login = useLogin();
  const { data: authConfig, isPending: configPending } = useAuthConfig();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Set by the OIDC callback redirect (?error=...).
  const [oidcError] = useState(() => new URLSearchParams(window.location.search).get("error"));

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
        {oidcError ? (
          <div className="mb-4">
            <ErrorNote>{OIDC_ERRORS[oidcError] ?? "Sign-in failed. Please try again."}</ErrorNote>
          </div>
        ) : null}
        {configPending ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-4">
            {authConfig?.oidcEnabled ? (
              <Button
                className="w-full justify-center"
                onClick={() => {
                  window.location.href = "/api/auth/oidc/login";
                }}
              >
                Continue with {authConfig.providerLabel ?? "SSO"}
              </Button>
            ) : null}
            {authConfig?.passwordLoginEnabled !== false ? (
              <>
                {authConfig?.oidcEnabled ? (
                  <div className="flex items-center gap-3 text-xs text-zinc-400">
                    <div className="h-px flex-1 bg-zinc-200" />
                    or
                    <div className="h-px flex-1 bg-zinc-200" />
                  </div>
                ) : null}
                <form onSubmit={onSubmit} className="space-y-4">
                  <div>
                    <label
                      htmlFor="username"
                      className="mb-1 block text-sm font-medium text-zinc-700"
                    >
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
                    <label
                      htmlFor="password"
                      className="mb-1 block text-sm font-medium text-zinc-700"
                    >
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
                  <Button
                    type="submit"
                    className="w-full justify-center"
                    disabled={login.isPending}
                  >
                    {login.isPending ? "Signing in…" : "Sign in"}
                  </Button>
                </form>
              </>
            ) : null}
          </div>
        )}
      </Card>
    </main>
  );
}
