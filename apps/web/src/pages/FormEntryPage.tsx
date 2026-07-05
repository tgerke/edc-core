import {
  type CodeList,
  displayText,
  type ItemDef,
  type MetaDataVersion,
  type ResolvedGroup,
  resolveGroup,
} from "@edc-core/odm";
import { buildRuleContext, compileEditChecks, runChecks } from "@edc-core/rules";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type FormData,
  useFormData,
  usePermissions,
  useSignForm,
  useStudyBuild,
  useTransitionForm,
  useWriteItem,
} from "../api/hooks.js";
import { QueryPanel } from "../components/QueryPanel.js";
import { Badge, Button, Card, ErrorNote, PageTitle, Spinner } from "../components/ui.js";
import { STATUS_STYLES, statusLabel } from "./MatrixPage.js";

// Mirrors FORM_TRANSITIONS in the API; the server remains the authority.
const ACTIONS_BY_STATUS: Record<string, { action: string; label: string }[]> = {
  in_progress: [{ action: "complete", label: "Mark complete" }],
  complete: [
    { action: "reopen", label: "Reopen" },
    { action: "verify", label: "Verify" },
    { action: "lock", label: "Lock" },
  ],
  verified: [
    { action: "unverify", label: "Unverify" },
    { action: "lock", label: "Lock" },
  ],
  signed: [
    { action: "reopen", label: "Reopen for correction" },
    { action: "lock", label: "Lock" },
  ],
  locked: [{ action: "unlock", label: "Unlock" }],
};

const SIGNABLE = new Set(["complete", "verified"]);
const SIGNATURE_MEANINGS = ["Investigator approval", "Review", "Responsibility"];

const WRITABLE = new Set(["not_started", "in_progress"]);

function collectItemOptions(
  group: ResolvedGroup,
): { oid: string; groupOid: string; label: string }[] {
  return group.children.flatMap((child) => {
    if (child.kind === "item") {
      const label =
        displayText(child.def.question) ?? displayText(child.def.description) ?? child.def.name;
      return [{ oid: child.def.oid, groupOid: group.def.oid, label }];
    }
    return collectItemOptions(child);
  });
}

function fieldKey(groupOid: string, repeatKey: number, itemOid: string): string {
  return `${groupOid}:${repeatKey}:${itemOid}`;
}

function EntryControl({
  def,
  codeList,
  value,
  disabled,
  onChange,
}: {
  def: ItemDef;
  codeList?: CodeList | undefined;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const base =
    "w-full max-w-sm rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-500";

  if (codeList) {
    return (
      <select
        className={base}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {codeList.items.map((item) => (
          <option key={item.codedValue} value={item.codedValue}>
            {displayText(item.decode) ?? item.codedValue}
          </option>
        ))}
      </select>
    );
  }

  const typeByDataType: Record<string, string> = {
    date: "date",
    datetime: "datetime-local",
    time: "time",
    integer: "number",
    float: "number",
    double: "number",
    decimal: "number",
  };

  if (def.dataType === "boolean") {
    return (
      <select
        className={base}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  return (
    <input
      type={typeByDataType[def.dataType] ?? "text"}
      className={base}
      value={value}
      disabled={disabled}
      maxLength={def.length}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function EntryGroup({
  group,
  depth,
  values,
  editable,
  onChange,
}: {
  group: ResolvedGroup;
  depth: number;
  values: Record<string, string>;
  editable: boolean;
  onChange: (key: string, value: string) => void;
}) {
  const isRepeating = group.def.repeating && group.def.repeating !== "No";
  return (
    <section className={depth > 0 ? "rounded-xl border border-zinc-200 bg-white p-4" : ""}>
      {depth > 0 ? (
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-900">{group.def.name}</h3>
          {isRepeating ? <Badge tone="sky">repeating · first occurrence shown</Badge> : null}
        </div>
      ) : null}
      <div className="divide-y divide-zinc-100">
        {group.children.map((child, index) => {
          if (child.kind === "item") {
            const key = fieldKey(group.def.oid, 1, child.def.oid);
            const label =
              displayText(child.def.question) ??
              displayText(child.def.description) ??
              child.def.name;
            return (
              <div key={key} className="grid gap-1.5 py-3">
                <div className="flex items-center gap-2">
                  <label htmlFor={key} className="text-sm font-medium text-zinc-800">
                    {label}
                  </label>
                  {child.ref.mandatory === "Yes" ? <span className="text-rose-500">*</span> : null}
                  <span className="ml-auto font-mono text-[11px] text-zinc-400">
                    {child.def.oid}
                  </span>
                </div>
                <div id={key}>
                  <EntryControl
                    def={child.def}
                    codeList={child.codeList}
                    value={values[key] ?? ""}
                    disabled={!editable}
                    onChange={(value) => onChange(key, value)}
                  />
                </div>
              </div>
            );
          }
          return (
            <div key={child.def.oid} className={index > 0 ? "pt-3" : ""}>
              <EntryGroup
                group={child}
                depth={depth + 1}
                values={values}
                editable={editable}
                onChange={onChange}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EntryForm({
  form,
  mdv,
  data,
}: {
  form: ResolvedGroup;
  mdv: MetaDataVersion;
  data: FormData;
}) {
  const writeItem = useWriteItem(data.context.formInstanceId);
  const transition = useTransitionForm(data.context.formInstanceId);
  const permissions = usePermissions(data.context.studyId, data.context.siteId);
  const checks = useMemo(() => compileEditChecks(mdv), [mdv]);
  const checkMessages = useMemo(() => new Map(checks.map((c) => [c.oid, c.message])), [checks]);
  const itemOptions = useMemo(() => collectItemOptions(form), [form]);

  const serverValues = useMemo(() => {
    const map: Record<string, string> = {};
    for (const value of data.values) {
      map[fieldKey(value.item_group_oid, value.item_group_repeat_key, value.item_oid)] =
        value.value ?? "";
    }
    return map;
  }, [data.values]);

  const [values, setValues] = useState<Record<string, string>>(serverValues);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const signForm = useSignForm(data.context.formInstanceId);
  const [signing, setSigning] = useState(false);
  const [signUsername, setSignUsername] = useState("");
  const [signPassword, setSignPassword] = useState("");
  const [signMeaning, setSignMeaning] = useState(SIGNATURE_MEANINGS[0] ?? "");

  // Refetches land while the user may hold unsaved edits (each write's
  // onSuccess refetches the form). Adopt the fresh server values but keep
  // whatever the user has touched since the previous server state.
  const prevServerRef = useRef(serverValues);
  useEffect(() => {
    const prevServer = prevServerRef.current;
    prevServerRef.current = serverValues;
    setValues((current) => {
      const next = { ...serverValues };
      for (const [key, value] of Object.entries(current)) {
        if ((value ?? "") !== (prevServer[key] ?? "")) next[key] = value;
      }
      return next;
    });
  }, [serverValues]);

  // Instant client-side evaluation of the same checks the server enforces.
  const [findings, setFindings] = useState<{ oid: string; message: string }[]>([]);
  useEffect(() => {
    if (checks.length === 0) return;
    let cancelled = false;
    const flat: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(values)) {
      const itemOid = key.split(":")[2];
      if (itemOid) flat[itemOid] = value === "" ? null : (value ?? null);
    }
    void runChecks(checks, buildRuleContext(mdv, flat)).then((results) => {
      if (cancelled) return;
      setFindings(
        [...results.entries()]
          .filter(([, result]) => result.fired)
          .map(([oid, result]) => ({ oid, message: result.message })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [values, checks, mdv]);

  const editable = WRITABLE.has(data.context.status);
  const dirtyKeys = Object.keys(values).filter(
    (key) => (values[key] ?? "") !== (serverValues[key] ?? ""),
  );
  const needsReason = dirtyKeys.some((key) => key in serverValues);

  async function save() {
    setError(null);
    setSaved(false);
    try {
      for (const key of dirtyKeys) {
        const [itemGroupOid = "", repeatKey = "1", itemOid = ""] = key.split(":");
        await writeItem.mutateAsync({
          itemGroupOid,
          itemGroupRepeatKey: Number(repeatKey),
          itemOid,
          value: values[key] === "" ? null : (values[key] ?? null),
          ...(key in serverValues && reason ? { reasonForChange: reason } : {}),
        });
      }
      setReason("");
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function act(action: string) {
    setError(null);
    setSaved(false);
    try {
      await transition.mutateAsync(action);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function sign() {
    setError(null);
    try {
      await signForm.mutateAsync({
        username: signUsername,
        password: signPassword,
        meaning: signMeaning,
      });
      setSigning(false);
      setSignUsername("");
      setSignPassword("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const canSign =
    SIGNABLE.has(data.context.status) && (permissions.data ?? []).includes("data.sign");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-md px-2 py-1 text-xs font-medium ring-1 ${STATUS_STYLES[data.context.status] ?? ""}`}
        >
          {statusLabel(data.context.status)}
        </span>
        <span className="text-xs text-zinc-400">build v{data.buildVersion}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {(ACTIONS_BY_STATUS[data.context.status] ?? []).map(({ action, label }) => (
            <Button
              key={action}
              variant="secondary"
              onClick={() => act(action)}
              disabled={transition.isPending || (action === "complete" && dirtyKeys.length > 0)}
            >
              {label}
            </Button>
          ))}
          {canSign ? (
            <Button onClick={() => setSigning((v) => !v)}>{signing ? "Cancel" : "Sign…"}</Button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {signing && canSign ? (
        <Card className="space-y-3 border-violet-200 bg-violet-50/40 p-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Electronic signature</h3>
            <p className="mt-1 text-xs text-zinc-500">
              21 CFR Part 11: re-enter your own username and password to sign. Your signature is
              bound to the data as it stands now; later corrections will invalidate it.
            </p>
          </div>
          <div className="grid max-w-md gap-2">
            <input
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
              placeholder="Username"
              autoComplete="off"
              value={signUsername}
              onChange={(e) => setSignUsername(e.target.value)}
            />
            <input
              type="password"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
              placeholder="Password"
              autoComplete="new-password"
              value={signPassword}
              onChange={(e) => setSignPassword(e.target.value)}
            />
            <select
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
              value={signMeaning}
              onChange={(e) => setSignMeaning(e.target.value)}
            >
              {SIGNATURE_MEANINGS.map((meaning) => (
                <option key={meaning} value={meaning}>
                  {meaning}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={sign} disabled={signForm.isPending || !signUsername || !signPassword}>
            {signForm.isPending ? "Signing…" : "Sign form"}
          </Button>
        </Card>
      ) : null}

      {data.signatures.length > 0 ? (
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-zinc-900">Signatures</h3>
          <ul className="mt-2 space-y-1.5">
            {data.signatures.map((signature) => (
              <li
                key={signature.id}
                className={`flex flex-wrap items-center gap-2 text-sm ${
                  signature.invalidatedAt ? "text-zinc-400 line-through" : "text-zinc-800"
                }`}
              >
                <span className="font-medium">{signature.signerName}</span>
                <span>·</span>
                <span>{signature.meaning}</span>
                <span>·</span>
                <span>{new Date(signature.signedAt).toLocaleString()}</span>
                {signature.invalidatedAt ? (
                  <span className="no-underline">
                    <Badge tone="amber">invalidated: {signature.invalidatedReason}</Badge>
                  </span>
                ) : (
                  <Badge tone="emerald">valid</Badge>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {saved ? (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-200">
          Saved.
        </div>
      ) : null}

      {data.openQueries.length > 0 ? (
        <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          <div className="font-medium">
            {data.openQueries.length} open quer{data.openQueries.length === 1 ? "y" : "ies"}
          </div>
          <ul className="mt-1 list-inside list-disc">
            {data.openQueries.map((query) => (
              <li key={query.id}>
                {query.checkOid
                  ? (checks.find((c) => c.oid === query.checkOid)?.message ?? query.checkOid)
                  : "Manual query"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {findings.length > 0 && editable ? (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          <div className="font-medium">Edit checks</div>
          <ul className="mt-1 list-inside list-disc">
            {findings.map((finding) => (
              <li key={finding.oid}>{finding.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card className="bg-zinc-50/50 p-6">
        <EntryGroup
          group={form}
          depth={0}
          values={values}
          editable={editable}
          onChange={(key, value) => {
            setSaved(false);
            setValues((prev) => ({ ...prev, [key]: value }));
          }}
        />
      </Card>

      {editable ? (
        <div className="flex flex-wrap items-center gap-3">
          {needsReason ? (
            <div className="w-72">
              <input
                className="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm placeholder:text-amber-700/60"
                placeholder="Reason for change (required)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          ) : null}
          <Button
            onClick={save}
            disabled={dirtyKeys.length === 0 || writeItem.isPending || (needsReason && !reason)}
          >
            {writeItem.isPending
              ? "Saving…"
              : `Save${dirtyKeys.length > 0 ? ` (${dirtyKeys.length})` : ""}`}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">
          This form is {statusLabel(data.context.status)} and read-only. Reopen it to make
          corrections.
        </p>
      )}

      <div className="border-t border-zinc-200 pt-4">
        <QueryPanel
          formInstanceId={data.context.formInstanceId}
          permissions={permissions.data ?? []}
          itemOptions={itemOptions}
          checkMessages={checkMessages}
        />
      </div>
    </div>
  );
}

export function FormEntryPage() {
  const { formInstanceId } = useParams({ from: "/app/forms/$formInstanceId" });
  const { data, isPending, isError } = useFormData(formInstanceId);
  const build = useStudyBuild(data?.context.studyId ?? "", data?.buildVersion ?? 0);

  const mdv = build.data?.study?.metaDataVersions[0];
  const resolved = useMemo(
    () => (mdv && data ? resolveGroup(mdv, data.context.formOid) : null),
    [mdv, data],
  );

  if (isPending || build.isPending) return <Spinner />;
  if (isError || !data || !mdv || !resolved) return <ErrorNote>Failed to load form.</ErrorNote>;

  return (
    <div>
      <div className="mb-2">
        <Link
          to="/studies/$studyId/subjects"
          params={{ studyId: data.context.studyId }}
          className="text-sm text-zinc-500 hover:text-zinc-800"
        >
          ← Back to subjects
        </Link>
      </div>
      <PageTitle
        sub={
          <>
            Subject {data.context.subjectKey} · {data.context.eventOid}
          </>
        }
      >
        {resolved.def.name}
      </PageTitle>
      <EntryForm form={resolved} mdv={mdv} data={data} />
    </div>
  );
}
