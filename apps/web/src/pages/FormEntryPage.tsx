import {
  type CodeList,
  displayText,
  type ItemDef,
  type MetaDataVersion,
  type ResolvedGroup,
  resolveGroup,
  resolveVariantForm,
  siteFormVariantDefinitionSchema,
} from "@edc-core/odm";
import {
  compileDerivations,
  compileEditChecks,
  evaluateFormState,
  type ItemValueRow,
  skipResidualMessages,
} from "@edc-core/rules";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type FormData,
  useAuthConfig,
  useFormData,
  useMe,
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

function parseFieldKey(key: string): { groupOid: string; repeatKey: number; itemOid: string } {
  const [groupOid = "", repeatKey = "1", itemOid = ""] = key.split(":");
  return { groupOid, repeatKey: Number(repeatKey), itemOid };
}

/** Occurrences to render for a repeating group: every stored key, plus added rows. */
function occurrenceCount(
  groupOid: string,
  values: Record<string, string>,
  added: Record<string, number>,
): number {
  let max = 1;
  for (const key of Object.keys(values)) {
    const parsed = parseFieldKey(key);
    if (parsed.groupOid === groupOid && parsed.repeatKey > max) max = parsed.repeatKey;
  }
  return max + (added[groupOid] ?? 0);
}

function EntryControl({
  def,
  codeList,
  value,
  disabled,
  excludedValues,
  onChange,
}: {
  def: ItemDef;
  codeList?: CodeList | undefined;
  value: string;
  disabled: boolean;
  excludedValues?: Set<string> | undefined;
  onChange: (value: string) => void;
}) {
  const base =
    "w-full max-w-sm rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-500";

  if (codeList) {
    // Excluded options disappear from the choice list — except a saved value
    // that has since become excluded, which stays visible and flagged rather
    // than leaving the select silently blank.
    const items = codeList.items.filter(
      (item) => !excludedValues?.has(item.codedValue) || item.codedValue === value,
    );
    return (
      <select
        className={base}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {items.map((item) => (
          <option key={item.codedValue} value={item.codedValue}>
            {displayText(item.decode) ?? item.codedValue}
            {excludedValues?.has(item.codedValue) ? " (no longer available)" : ""}
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

/** Read-only rendering of a stored value: decode code list values and map
 *  booleans to Yes/No, the same way the editable controls present them. */
function readOnlyDisplayValue(def: ItemDef, codeList: CodeList | undefined, raw: string): string {
  if (raw === "") return "";
  if (codeList) {
    const item = codeList.items.find((i) => i.codedValue === raw);
    return item ? (displayText(item.decode) ?? item.codedValue) : raw;
  }
  if (def.dataType === "boolean") return raw === "true" || raw === "1" ? "Yes" : "No";
  return raw;
}

/** Client-side dynamic form state (ADR-0014), recomputed on every edit. */
interface DynamicState {
  /** Field occurrences not collected under the current responses. */
  skipped: Set<string>;
  /** Excluded code list options per field occurrence. */
  excluded: Map<string, Set<string>>;
  /** `${groupOid}:${itemOid}` pairs whose value is computed, never entered. */
  derivedItems: Set<string>;
  /** Locally computed derived values (preview; the server recomputes). */
  derivedValues: Record<string, string>;
}

/** A section with nothing to show (every field skipped and empty) is hidden
 *  entirely rather than rendered as an empty shell. */
function groupHasVisibleContent(
  group: ResolvedGroup,
  repeatKey: number,
  dynamic: DynamicState,
  serverValues: Record<string, string>,
): boolean {
  return group.children.some((child) => {
    if (child.kind === "item") {
      const key = fieldKey(child.canonicalGroupOid ?? group.def.oid, repeatKey, child.def.oid);
      return !dynamic.skipped.has(key) || (serverValues[key] ?? "") !== "";
    }
    // Repeating subgroups keep their own occurrence controls visible.
    if (child.def.repeating && child.def.repeating !== "No") return true;
    // Non-repeating subgroups always render at repeat key 1.
    return groupHasVisibleContent(child, 1, dynamic, serverValues);
  });
}

function EntryGroup({
  group,
  depth,
  repeatKey = 1,
  values,
  serverValues,
  editable,
  blinded,
  added,
  dynamic,
  onChange,
  onAddOccurrence,
}: {
  group: ResolvedGroup;
  depth: number;
  repeatKey?: number;
  values: Record<string, string>;
  serverValues: Record<string, string>;
  editable: boolean;
  blinded: Set<string>;
  added: Record<string, number>;
  dynamic: DynamicState;
  onChange: (key: string, value: string) => void;
  onAddOccurrence: (groupOid: string) => void;
}) {
  const isRepeating = group.def.repeating && group.def.repeating !== "No";
  return (
    <section className={depth > 0 ? "rounded-xl border border-zinc-200 bg-white p-4" : ""}>
      {depth > 0 ? (
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-900">{group.def.name}</h3>
          {isRepeating ? <Badge tone="sky">occurrence {repeatKey}</Badge> : null}
        </div>
      ) : null}
      <div className="divide-y divide-zinc-100">
        {group.children.map((child, index) => {
          if (child.kind === "item") {
            // Variant layouts are presentation-only: writes key on the item's
            // canonical build group so the data shape stays identical.
            const canonicalGroupOid = child.canonicalGroupOid ?? group.def.oid;
            const key = fieldKey(canonicalGroupOid, repeatKey, child.def.oid);
            const isBlinded = blinded.has(child.def.oid);
            const isDerived = dynamic.derivedItems.has(`${canonicalGroupOid}:${child.def.oid}`);
            const isSkipped = dynamic.skipped.has(key);
            const savedValue = serverValues[key] ?? "";
            // A skipped field with nothing saved simply is not collected.
            if (isSkipped && savedValue === "") return null;
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
                  {isBlinded ? <Badge tone="amber">blinded</Badge> : null}
                  {isDerived ? <Badge tone="sky">computed</Badge> : null}
                  {isSkipped ? <Badge tone="amber">not collected</Badge> : null}
                  <span className="ml-auto font-mono text-[11px] text-zinc-400">
                    {child.def.oid}
                  </span>
                </div>
                <div id={key}>
                  {isBlinded ? (
                    <input
                      className="w-full max-w-sm rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-400"
                      value="Blinded for your role"
                      disabled
                    />
                  ) : isSkipped ? (
                    // Retained value in a not-collected field: read-only, with
                    // an explicit audited clear (prompts reason-for-change).
                    <div className="flex max-w-sm items-center gap-2">
                      <input
                        className="w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-zinc-600"
                        value={readOnlyDisplayValue(
                          child.def,
                          child.codeList,
                          values[key] ?? savedValue,
                        )}
                        disabled
                      />
                      {editable && (values[key] ?? savedValue) !== "" ? (
                        <Button variant="secondary" onClick={() => onChange(key, "")}>
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  ) : isDerived ? (
                    <input
                      className="w-full max-w-sm rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600"
                      value={readOnlyDisplayValue(
                        child.def,
                        child.codeList,
                        dynamic.derivedValues[key] ?? values[key] ?? "",
                      )}
                      disabled
                    />
                  ) : (
                    <EntryControl
                      def={child.def}
                      codeList={child.codeList}
                      value={values[key] ?? ""}
                      disabled={!editable}
                      excludedValues={dynamic.excluded.get(key)}
                      onChange={(value) => onChange(key, value)}
                    />
                  )}
                </div>
              </div>
            );
          }

          const childRepeats = child.def.repeating && child.def.repeating !== "No";
          if (!childRepeats) {
            if (!groupHasVisibleContent(child, 1, dynamic, serverValues)) return null;
            return (
              <div key={child.def.oid} className={index > 0 ? "pt-3" : ""}>
                <EntryGroup
                  group={child}
                  depth={depth + 1}
                  values={values}
                  serverValues={serverValues}
                  editable={editable}
                  blinded={blinded}
                  added={added}
                  dynamic={dynamic}
                  onChange={onChange}
                  onAddOccurrence={onAddOccurrence}
                />
              </div>
            );
          }

          const count = occurrenceCount(child.def.oid, values, added);
          return (
            <div key={child.def.oid} className={`space-y-3 ${index > 0 ? "pt-3" : ""}`}>
              {Array.from({ length: count }, (_, i) => i + 1).map((occurrence) => (
                <EntryGroup
                  key={occurrence}
                  group={child}
                  depth={depth + 1}
                  repeatKey={occurrence}
                  values={values}
                  serverValues={serverValues}
                  editable={editable}
                  blinded={blinded}
                  added={added}
                  dynamic={dynamic}
                  onChange={onChange}
                  onAddOccurrence={onAddOccurrence}
                />
              ))}
              {editable ? (
                <Button variant="secondary" onClick={() => onAddOccurrence(child.def.oid)}>
                  + Add {child.def.name} occurrence
                </Button>
              ) : null}
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
  // Skip-residual queries carry synthetic SKIP.* check OIDs; merge their
  // display text so open queries never render as raw OIDs.
  const checkMessages = useMemo(
    () =>
      new Map([
        ...checks.map((c): [string, string] => [c.oid, c.message]),
        ...skipResidualMessages(mdv),
      ]),
    [checks, mdv],
  );
  const derivedItems = useMemo(
    () => new Set(compileDerivations(mdv).map((d) => `${d.itemGroupOid}:${d.itemOid}`)),
    [mdv],
  );
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
  const [added, setAdded] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const signForm = useSignForm(data.context.formInstanceId);
  const { data: me } = useMe();
  const { data: authConfig } = useAuthConfig();
  const [signing, setSigning] = useState(false);
  const [signUsername, setSignUsername] = useState("");
  const [signPassword, setSignPassword] = useState("");
  const [signMeaning, setSignMeaning] = useState(SIGNATURE_MEANINGS[0] ?? "");
  const [reauthPending, setReauthPending] = useState(false);
  // Accounts without a local password re-authenticate through the IdP.
  const oidcSigner = me != null && !me.hasPassword;

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

  // Instant client-side evaluation of the same pipeline the server enforces
  // (derivations → skip logic → option exclusions → checks), occurrence-aware
  // for repeating item groups. The server recomputes authoritatively on write.
  const [findings, setFindings] = useState<
    { oid: string; message: string; repeatKey: number | null }[]
  >([]);
  const [dynamic, setDynamic] = useState<DynamicState>({
    skipped: new Set(),
    excluded: new Map(),
    derivedItems,
    derivedValues: {},
  });
  useEffect(() => {
    let cancelled = false;
    const rows: ItemValueRow[] = Object.entries(values).map(([key, value]) => {
      const parsed = parseFieldKey(key);
      return {
        itemGroupOid: parsed.groupOid,
        itemGroupRepeatKey: parsed.repeatKey,
        itemOid: parsed.itemOid,
        value: value === "" ? null : (value ?? null),
      };
    });
    void evaluateFormState(mdv, rows).then((state) => {
      if (cancelled) return;
      setFindings(
        state.findings.map((f) => ({
          oid: f.checkOid,
          message: f.message,
          repeatKey: f.repeatKey,
        })),
      );
      const derivedValues: Record<string, string> = {};
      for (const entry of state.derived) {
        derivedValues[fieldKey(entry.itemGroupOid, entry.itemGroupRepeatKey, entry.itemOid)] =
          entry.value ?? "";
      }
      setDynamic({
        skipped: state.skippedFields,
        excluded: state.excludedOptions,
        derivedItems,
        derivedValues,
      });
      // Unsaved local edits in fields that just became skipped are dropped:
      // nothing is persisted, and a hidden field must not hold a pending
      // write. Saved values stay put (retain-and-flag, cleared explicitly).
      setValues((current) => {
        let changed = false;
        const next = { ...current };
        for (const key of state.skippedFields) {
          if ((next[key] ?? "") !== "" && (prevServerRef.current[key] ?? "") === "") {
            delete next[key];
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [values, mdv, derivedItems]);

  const editable = WRITABLE.has(data.context.status);
  const dirtyKeys = Object.keys(values).filter((key) => {
    if ((values[key] ?? "") === (serverValues[key] ?? "")) return false;
    // Derived values are server-written; the client preview never saves them.
    const parsed = parseFieldKey(key);
    return !derivedItems.has(`${parsed.groupOid}:${parsed.itemOid}`);
  });
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

  // OIDC re-auth: a popup runs a fresh interactive IdP login and posts back
  // a single-use grant, which stands in for password re-entry at signing.
  async function signWithSso() {
    setError(null);
    setReauthPending(true);
    try {
      const popup = window.open(
        "/api/auth/oidc/login?purpose=reauth",
        "edc-reauth",
        "width=480,height=640",
      );
      if (!popup) throw new Error("Popup blocked — allow popups for this site to sign.");
      const grant = await new Promise<string>((resolve, reject) => {
        const closedPoll = window.setInterval(() => {
          if (popup.closed) {
            cleanup();
            reject(new Error("Re-authentication was cancelled."));
          }
        }, 500);
        function cleanup() {
          window.clearInterval(closedPoll);
          window.removeEventListener("message", onMessage);
        }
        function onMessage(event: MessageEvent) {
          if (event.origin !== window.location.origin) return;
          const message = event.data as { type?: string; grant?: string; error?: string };
          if (message?.type !== "edc-reauth") return;
          cleanup();
          if (message.grant) resolve(message.grant);
          else reject(new Error("Re-authentication failed. Please try again."));
        }
        window.addEventListener("message", onMessage);
      });
      await signForm.mutateAsync({ reauthGrant: grant, meaning: signMeaning });
      setSigning(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReauthPending(false);
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
              {oidcSigner
                ? "21 CFR Part 11: re-authenticate with your identity provider to sign. Your signature is bound to the data as it stands now; later corrections will invalidate it."
                : "21 CFR Part 11: re-enter your own username and password to sign. Your signature is bound to the data as it stands now; later corrections will invalidate it."}
            </p>
          </div>
          <div className="grid max-w-md gap-2">
            {oidcSigner ? null : (
              <>
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
              </>
            )}
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
          {oidcSigner ? (
            <Button onClick={signWithSso} disabled={signForm.isPending || reauthPending}>
              {reauthPending
                ? "Waiting for re-authentication…"
                : `Re-authenticate with ${authConfig?.providerLabel ?? "SSO"} and sign`}
            </Button>
          ) : (
            <Button onClick={sign} disabled={signForm.isPending || !signUsername || !signPassword}>
              {signForm.isPending ? "Signing…" : "Sign form"}
            </Button>
          )}
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
                  ? (checkMessages.get(query.checkOid) ?? query.checkOid)
                  : "Manual query"}
                {query.itemGroupRepeatKey != null
                  ? ` (occurrence ${query.itemGroupRepeatKey})`
                  : ""}
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
              <li key={`${finding.oid}:${finding.repeatKey ?? ""}`}>
                {finding.message}
                {finding.repeatKey != null ? ` (occurrence ${finding.repeatKey})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card className="bg-zinc-50/50 p-6">
        <EntryGroup
          group={form}
          depth={0}
          values={values}
          serverValues={serverValues}
          editable={editable}
          blinded={new Set(data.blindedItems ?? [])}
          added={added}
          dynamic={dynamic}
          onChange={(key, value) => {
            setSaved(false);
            setValues((prev) => ({ ...prev, [key]: value }));
          }}
          onAddOccurrence={(groupOid) =>
            setAdded((prev) => ({ ...prev, [groupOid]: (prev[groupOid] ?? 0) + 1 }))
          }
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
  const resolved = useMemo(() => {
    if (!mdv || !data) return null;
    if (data.context.formOid.startsWith("V.") && data.variantDefinition) {
      const definition = siteFormVariantDefinitionSchema.safeParse(data.variantDefinition);
      if (definition.success) {
        return resolveVariantForm(mdv, definition.data, data.context.formOid);
      }
    }
    return resolveGroup(mdv, data.context.formOid);
  }, [mdv, data]);

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
