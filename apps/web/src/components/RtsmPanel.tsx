import {
  formsForEvent,
  type MetaDataVersion,
  type ResolvedGroup,
  type ResolvedItem,
  resolveGroup,
} from "@edc-core/odm";
import { useState } from "react";
import {
  type MintedRtsmKey,
  type RtsmEvent,
  useMetadataVersions,
  useMintRtsmKey,
  useRevokeRtsmKey,
  useRtsmConfig,
  useRtsmEvents,
  useRtsmKeys,
  useSaveRtsmConfig,
  useStudyBuild,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Spinner } from "./ui.js";

const OUTCOME_TONES: Record<RtsmEvent["outcome"], "emerald" | "sky" | "amber"> = {
  applied: "emerald",
  duplicate: "sky",
  conflict: "amber",
  rejected: "amber",
};

interface ConfigDraft {
  eventOid: string;
  formOid: string;
  itemGroupOid: string;
  itemOid: string;
  enabled: boolean;
}

/** Groups (nested included) that directly contain items, in document order. */
function groupsWithItems(root: ResolvedGroup): { oid: string; name: string }[] {
  const out: { oid: string; name: string }[] = [];
  const visit = (group: ResolvedGroup) => {
    if (group.children.some((c) => c.kind === "item")) {
      out.push({ oid: group.def.oid, name: group.def.name });
    }
    for (const child of group.children) if (child.kind === "group") visit(child);
  };
  visit(root);
  return out;
}

function itemsOfGroup(root: ResolvedGroup, groupOid: string): ResolvedItem[] {
  let found: ResolvedItem[] = [];
  const visit = (group: ResolvedGroup) => {
    if (group.def.oid === groupOid) {
      found = group.children.filter((c): c is ResolvedItem => c.kind === "item");
    }
    for (const child of group.children) if (child.kind === "group") visit(child);
  };
  visit(root);
  return found;
}

function OidSelect({
  title,
  value,
  onChange,
  options,
  disabled,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  options: { oid: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="text-xs text-zinc-500">
      {title}
      <select
        className="mt-0.5 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title={title}
      >
        <option value="">Select…</option>
        {options.map((option) => (
          <option key={option.oid} value={option.oid}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Cascading pickers driven by the latest build (#68): each level narrows
 * the next, and changing a parent clears everything downstream. */
function ConfigPickers({
  mdv,
  draft,
  setDraft,
}: {
  mdv: MetaDataVersion;
  draft: ConfigDraft;
  setDraft: (draft: ConfigDraft) => void;
}) {
  const forms = draft.eventOid ? formsForEvent(mdv, draft.eventOid) : [];
  const resolvedForm = draft.formOid ? resolveGroup(mdv, draft.formOid) : null;
  const groups = resolvedForm ? groupsWithItems(resolvedForm) : [];
  const items =
    resolvedForm && draft.itemGroupOid ? itemsOfGroup(resolvedForm, draft.itemGroupOid) : [];

  return (
    <div className="grid max-w-xl grid-cols-2 gap-2">
      <OidSelect
        title="Event"
        value={draft.eventOid}
        options={mdv.studyEventDefs.map((e) => ({ oid: e.oid, label: `${e.name} (${e.oid})` }))}
        onChange={(eventOid) =>
          setDraft({ ...draft, eventOid, formOid: "", itemGroupOid: "", itemOid: "" })
        }
      />
      <OidSelect
        title="Form"
        value={draft.formOid}
        options={forms.map((f) => ({ oid: f.oid, label: `${f.name} (${f.oid})` }))}
        onChange={(formOid) => setDraft({ ...draft, formOid, itemGroupOid: "", itemOid: "" })}
        disabled={draft.eventOid === ""}
      />
      <OidSelect
        title="Item group"
        value={draft.itemGroupOid}
        options={groups.map((g) => ({ oid: g.oid, label: `${g.name} (${g.oid})` }))}
        onChange={(itemGroupOid) => setDraft({ ...draft, itemGroupOid, itemOid: "" })}
        disabled={draft.formOid === ""}
      />
      <OidSelect
        title="Arm item"
        value={draft.itemOid}
        options={items.map((i) => ({
          oid: i.def.oid,
          label: `${i.def.name} (${i.def.oid})${i.def.blinded ? " — blinded" : ""}`,
        }))}
        onChange={(itemOid) => setDraft({ ...draft, itemOid })}
        disabled={draft.itemGroupOid === ""}
      />
    </div>
  );
}

export function RtsmPanel({ studyId }: { studyId: string }) {
  const { data: config, isPending } = useRtsmConfig(studyId);
  const saveConfig = useSaveRtsmConfig(studyId);
  const { data: keys } = useRtsmKeys(studyId);
  const mintKey = useMintRtsmKey(studyId);
  const revokeKey = useRevokeRtsmKey(studyId);
  const { data: events } = useRtsmEvents(studyId);
  const { data: versions } = useMetadataVersions(studyId);
  const latestVersion = versions?.reduce((max, v) => Math.max(max, v.version), 0) ?? 0;
  const { data: build } = useStudyBuild(studyId, latestVersion);
  const mdv = latestVersion > 0 ? build?.study?.metaDataVersions[0] : undefined;

  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<MintedRtsmKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSaveConfig() {
    if (!draft) return;
    setError(null);
    try {
      await saveConfig.mutateAsync(draft);
      setDraft(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onMint() {
    setError(null);
    try {
      setMinted(await mintKey.mutateAsync({ label }));
      setLabel("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onRevoke(keyId: string) {
    setError(null);
    try {
      await revokeKey.mutateAsync(keyId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const liveKeys = keys?.filter((k) => !k.revokedAt) ?? [];

  return (
    <div className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        RTSM integration
      </h2>
      <Card className="space-y-4 p-4">
        {isPending ? <Spinner /> : null}

        <div className="space-y-2 text-sm text-zinc-700">
          {config && !draft ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={config.enabled ? "emerald" : "amber"}>
                {config.enabled ? "enabled" : "disabled"}
              </Badge>
              <span>
                Arm lands on <span className="font-mono text-xs">{config.itemOid}</span> in{" "}
                <span className="font-mono text-xs">{config.itemGroupOid}</span> on form{" "}
                <span className="font-mono text-xs">{config.formOid}</span> at event{" "}
                <span className="font-mono text-xs">{config.eventOid}</span>
              </span>
              <Button
                variant="ghost"
                onClick={() =>
                  setDraft({
                    eventOid: config.eventOid,
                    formOid: config.formOid,
                    itemGroupOid: config.itemGroupOid,
                    itemOid: config.itemOid,
                    enabled: config.enabled,
                  })
                }
              >
                Edit
              </Button>
            </div>
          ) : null}
          {!config && !draft && !isPending ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-zinc-500">
                {mdv
                  ? "Not configured — pick the eCRF item where incoming randomization arms land."
                  : "Not configured — publish a study build first, then pick the arm item here."}
              </span>
              {mdv ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    setDraft({
                      eventOid: "",
                      formOid: "",
                      itemGroupOid: "",
                      itemOid: "",
                      enabled: true,
                    })
                  }
                >
                  Configure
                </Button>
              ) : null}
            </div>
          ) : null}
          {draft && mdv ? (
            <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
              <ConfigPickers mdv={mdv} draft={draft} setDraft={setDraft} />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                Accept assignments
              </label>
              <div className="flex gap-2">
                <Button
                  onClick={onSaveConfig}
                  disabled={
                    saveConfig.isPending ||
                    draft.eventOid === "" ||
                    draft.formOid === "" ||
                    draft.itemGroupOid === "" ||
                    draft.itemOid === ""
                  }
                >
                  {saveConfig.isPending ? "Saving…" : "Save configuration"}
                </Button>
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                Choices come from the latest study build and are re-validated on save. Blind the arm
                item (edc:Blinded) in the build if this study is masked.
              </p>
            </div>
          ) : null}
        </div>

        <div className="space-y-2 border-t border-zinc-100 pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
            <span className="font-medium">API keys</span>
            <input
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
              placeholder="Label, e.g. Vendor X production"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button onClick={onMint} disabled={label === "" || mintKey.isPending}>
              {mintKey.isPending ? "Minting…" : "Mint key"}
            </Button>
          </div>
          {minted ? (
            <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
              <div className="font-medium">
                Key “{minted.label}” minted — copy it now; it will not be shown again.
              </div>
              <code className="mt-1 block select-all break-all font-mono text-xs">
                {minted.token}
              </code>
              <Button variant="ghost" onClick={() => setMinted(null)}>
                Dismiss
              </Button>
            </div>
          ) : null}
          {keys && keys.length > 0 ? (
            <ul className="space-y-1 text-sm text-zinc-700">
              {keys.map((key) => (
                <li key={key.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={key.revokedAt ? "amber" : "emerald"}>
                    {key.revokedAt ? "revoked" : "active"}
                  </Badge>
                  <span>{key.label}</span>
                  <span className="font-mono text-xs text-zinc-400">{key.tokenPrefix}…</span>
                  <span className="text-xs text-zinc-400">
                    last used {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}
                  </span>
                  {key.expiresAt ? (
                    <span className="text-xs text-zinc-400">
                      expires {new Date(key.expiresAt).toLocaleDateString()}
                    </span>
                  ) : null}
                  {!key.revokedAt ? (
                    <Button
                      variant="ghost"
                      onClick={() => onRevoke(key.id)}
                      disabled={revokeKey.isPending}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-500">
              No keys yet. The external RTSM authenticates with a study-scoped key and can only post
              assignments — it can never read data.
            </p>
          )}
          {liveKeys.length > 0 ? (
            <p className="text-xs text-zinc-500">
              Endpoint:{" "}
              <code className="font-mono">POST /api/studies/{studyId}/rtsm/assignments</code> with{" "}
              <code className="font-mono">
                {"{"} subjectKey, arm, randomizationId {"}"}
              </code>
            </p>
          ) : null}
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {events && events.length > 0 ? (
          <details className="border-t border-zinc-100 pt-3 text-sm text-zinc-700" open>
            <summary className="cursor-pointer text-zinc-500">
              Recent assignments ({events.length})
            </summary>
            <ul className="mt-2 space-y-1">
              {events.slice(0, 15).map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={OUTCOME_TONES[event.outcome]}>{event.outcome}</Badge>
                  <span>{event.subjectKey}</span>
                  <span className="font-mono text-xs text-zinc-400">{event.randomizationId}</span>
                  <span className="font-mono text-xs">
                    {typeof event.payload.arm === "string" ? event.payload.arm : "—"}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                  {event.reason ? (
                    <span className="text-xs text-amber-700">{event.reason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>
    </div>
  );
}
