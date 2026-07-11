import { useState } from "react";
import {
  type MintedRtsmKey,
  type RtsmEvent,
  useMintRtsmKey,
  useRevokeRtsmKey,
  useRtsmConfig,
  useRtsmEvents,
  useRtsmKeys,
  useSaveRtsmConfig,
} from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Spinner } from "./ui.js";

const OUTCOME_TONES: Record<RtsmEvent["outcome"], "emerald" | "sky" | "amber"> = {
  applied: "emerald",
  duplicate: "sky",
  conflict: "amber",
  rejected: "amber",
};

const CONFIG_FIELDS = [
  ["eventOid", "Event OID", "SE.RAND"],
  ["formOid", "Form OID", "FO.RAND"],
  ["itemGroupOid", "Item group OID", "IG.RAND"],
  ["itemOid", "Arm item OID", "IT.ARM"],
] as const;

type ConfigDraft = Record<(typeof CONFIG_FIELDS)[number][0], string> & { enabled: boolean };

export function RtsmPanel({ studyId }: { studyId: string }) {
  const { data: config, isPending } = useRtsmConfig(studyId);
  const saveConfig = useSaveRtsmConfig(studyId);
  const { data: keys } = useRtsmKeys(studyId);
  const mintKey = useMintRtsmKey(studyId);
  const revokeKey = useRevokeRtsmKey(studyId);
  const { data: events } = useRtsmEvents(studyId);

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
                Not configured — pick the eCRF item where incoming randomization arms land.
              </span>
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
            </div>
          ) : null}
          {draft ? (
            <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
              <div className="grid max-w-xl grid-cols-2 gap-2">
                {CONFIG_FIELDS.map(([field, title, placeholder]) => (
                  <label key={field} className="text-xs text-zinc-500">
                    {title}
                    <input
                      className="mt-0.5 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1 font-mono text-xs text-zinc-800"
                      placeholder={placeholder}
                      value={draft[field]}
                      onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
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
                    saveConfig.isPending || CONFIG_FIELDS.some(([field]) => draft[field] === "")
                  }
                >
                  {saveConfig.isPending ? "Saving…" : "Save configuration"}
                </Button>
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                OIDs are validated against the latest study build on save. Blind the arm item
                (edc:Blinded) in the build if this study is masked.
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
