import { useState } from "react";
import { type QueryThread, useFormQueries, useOpenQuery, useQueryAction } from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Spinner } from "./ui.js";

export const QUERY_STATUS_TONE: Record<QueryThread["status"], "amber" | "sky" | "zinc"> = {
  open: "amber",
  answered: "sky",
  closed: "zinc",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString();
}

function Thread({
  query,
  canAnswer,
  canManage,
  checkMessage,
}: {
  query: QueryThread;
  canAnswer: boolean;
  canManage: boolean;
  checkMessage?: string | undefined;
}) {
  const action = useQueryAction();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "answer" | "reopen" | "close") {
    setError(null);
    try {
      await action.mutateAsync({ queryId: query.id, action: kind, ...(body ? { body } : {}) });
      setBody("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const showAnswer = canAnswer && query.status === "open";
  const showReopen = canManage && query.status === "answered";
  const showClose = canManage && query.status !== "closed";
  const showComposer = showAnswer || showReopen || showClose;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={QUERY_STATUS_TONE[query.status]}>{query.status}</Badge>
        <Badge tone={query.origin === "system" ? "sky" : "zinc"}>{query.origin}</Badge>
        {query.itemOid ? (
          <span className="font-mono text-[11px] text-zinc-400">{query.itemOid}</span>
        ) : null}
        {query.itemGroupRepeatKey != null ? (
          <Badge>occurrence {query.itemGroupRepeatKey}</Badge>
        ) : null}
        <span className="ml-auto text-xs text-zinc-400">
          opened by {query.openedBy} · {when(query.createdAt)}
        </span>
      </div>
      {query.checkOid ? (
        <p className="mt-2 text-sm text-zinc-800">Edit check: {checkMessage ?? query.checkOid}</p>
      ) : null}
      {query.messages.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {query.messages.map((message) => (
            <li key={message.id} className="rounded-lg bg-zinc-50 px-3 py-2">
              <div className="text-xs text-zinc-400">
                {message.author} · {when(message.createdAt)}
              </div>
              <div className="mt-0.5 text-sm text-zinc-800">{message.body}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {showComposer ? (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <textarea
            className="min-h-[38px] w-full max-w-md rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200"
            placeholder={showAnswer ? "Write an answer…" : "Add a message (optional for close)…"}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
          />
          <div className="flex gap-2">
            {showAnswer ? (
              <Button onClick={() => run("answer")} disabled={action.isPending || !body}>
                Answer
              </Button>
            ) : null}
            {showReopen ? (
              <Button
                variant="secondary"
                onClick={() => run("reopen")}
                disabled={action.isPending || !body}
              >
                Reopen
              </Button>
            ) : null}
            {showClose ? (
              <Button variant="secondary" onClick={() => run("close")} disabled={action.isPending}>
                Close
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Threaded query panel for one form instance. Buttons follow the advisory
 * permissions endpoint; the server independently enforces every action.
 */
export function QueryPanel({
  formInstanceId,
  permissions,
  itemOptions,
  checkMessages,
}: {
  formInstanceId: string;
  permissions: string[];
  itemOptions: { oid: string; groupOid: string; label: string }[];
  checkMessages: Map<string, string>;
}) {
  const { data: threads, isPending, isError } = useFormQueries(formInstanceId);
  const openQuery = useOpenQuery(formInstanceId);
  const [composing, setComposing] = useState(false);
  const [itemOid, setItemOid] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canManage = permissions.includes("query.manage");
  const canAnswer = permissions.includes("query.answer");

  async function open() {
    setError(null);
    const item = itemOptions.find((option) => option.oid === itemOid);
    try {
      await openQuery.mutateAsync({
        body,
        ...(item ? { itemOid: item.oid, itemGroupOid: item.groupOid } : {}),
      });
      setBody("");
      setItemOid("");
      setComposing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (isPending) return <Spinner />;
  if (isError || !threads) return <ErrorNote>Failed to load queries.</ErrorNote>;

  const active = threads.filter((t) => t.status !== "closed");
  const closed = threads.filter((t) => t.status === "closed");

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-zinc-900">Queries</h2>
        {active.length > 0 ? <Badge tone="amber">{active.length} active</Badge> : null}
        {canManage ? (
          <Button variant="secondary" className="ml-auto" onClick={() => setComposing((v) => !v)}>
            {composing ? "Cancel" : "New query"}
          </Button>
        ) : null}
      </div>

      {composing ? (
        <Card className="space-y-2 p-4">
          <select
            className="w-full max-w-md rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900"
            value={itemOid}
            onChange={(e) => setItemOid(e.target.value)}
          >
            <option value="">Whole form</option>
            {itemOptions.map((option) => (
              <option key={option.oid} value={option.oid}>
                {option.label}
              </option>
            ))}
          </select>
          <textarea
            className="min-h-[60px] w-full max-w-md rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200"
            placeholder="Describe the data issue…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
          />
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button onClick={open} disabled={openQuery.isPending || !body}>
            Open query
          </Button>
        </Card>
      ) : null}

      {threads.length === 0 ? (
        <p className="text-sm text-zinc-500">No queries on this form.</p>
      ) : (
        <div className="space-y-3">
          {[...active, ...closed].map((query) => (
            <Thread
              key={query.id}
              query={query}
              canAnswer={canAnswer}
              canManage={canManage}
              checkMessage={query.checkOid ? checkMessages.get(query.checkOid) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
