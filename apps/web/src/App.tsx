import { type HealthResponse, healthResponseSchema } from "@edc-core/schemas";
import { useEffect, useState } from "react";

type ApiStatus =
  | { state: "checking" }
  | { state: "up"; health: HealthResponse }
  | { state: "down" };

function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then(async (res) => healthResponseSchema.parse(await res.json()))
      .then((health) => {
        if (!cancelled) setStatus({ state: "up", health });
      })
      .catch(() => {
        if (!cancelled) setStatus({ state: "down" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

function StatusPill({ status }: { status: ApiStatus }) {
  const styles = {
    checking: "bg-zinc-100 text-zinc-600 ring-zinc-200",
    up: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    down: "bg-rose-50 text-rose-700 ring-rose-200",
  }[status.state];
  const label = {
    checking: "checking API…",
    up: `API up · v${status.state === "up" ? status.health.version : ""}`,
    down: "API unreachable",
  }[status.state];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ${styles}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export function App() {
  const status = useApiStatus();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-2xl space-y-6 text-center">
        <StatusPill status={status} />
        <h1 className="text-5xl font-semibold tracking-tight text-zinc-900">edc-core</h1>
        <p className="text-lg leading-relaxed text-zinc-600">
          A modern, open-source Electronic Data Capture system for clinical research. Standards
          first, compliance by construction, no lock-in.
        </p>
        <div className="flex items-center justify-center gap-4 text-sm text-zinc-500">
          <span>CDISC ODM v2.0</span>
          <span aria-hidden>·</span>
          <span>21 CFR Part 11</span>
          <span aria-hidden>·</span>
          <span>ICH E6(R3)</span>
          <span aria-hidden>·</span>
          <span>AGPL-3.0</span>
        </div>
      </div>
    </main>
  );
}
