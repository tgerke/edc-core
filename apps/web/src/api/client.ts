export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: unknown[],
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
  if (!response.ok) {
    let message = response.statusText;
    let issues: unknown[] | undefined;
    try {
      const body = (await response.json()) as { error?: string; issues?: unknown[] };
      message = body.error ?? message;
      issues = body.issues;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(response.status, message, issues);
  }
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/json") ? response.json() : response.text()
  ) as Promise<T>;
}
