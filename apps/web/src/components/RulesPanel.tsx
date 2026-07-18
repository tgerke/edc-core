import {
  addConditionDef,
  addMethodDef,
  type ConditionDef,
  conditionReferenceCount,
  displayText,
  jsonataExpression,
  type MetaDataVersion,
  type MethodDef,
  methodReferenceCount,
  removeConditionDef,
  removeMethodDef,
  updateConditionDef,
  updateMethodDef,
} from "@edc-core/odm";
import { expressionSyntaxError } from "@edc-core/rules";
import type { ReactNode } from "react";
import { Badge, Button, Input } from "./ui.js";

/**
 * Authoring panel for ConditionDefs and MethodDefs (ADR-0014 follow-up).
 * A condition's role follows from how it is referenced: wired as a
 * collection exception it is skip logic (true hides the target); left
 * unreferenced it runs as an edit check (true raises a query). Methods
 * are derivations, wired to items in the form editor.
 */

const expressionClass =
  "w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none";

function SyntaxNote({ code }: { code: string | undefined }) {
  if (!code) return null;
  const error = expressionSyntaxError(code);
  if (error === null) return null;
  return <p className="text-xs text-rose-600">Expression does not parse: {error}</p>;
}

function RuleRow({
  def,
  refCount,
  roleBadge,
  editing,
  onPatch,
  onRemove,
}: {
  def: ConditionDef | MethodDef;
  refCount: number;
  roleBadge: ReactNode;
  editing: boolean;
  onPatch: (patch: { name?: string; description?: string; expression?: string | null }) => void;
  onRemove: () => void;
}) {
  const expression = jsonataExpression(def);
  const description = displayText(def.description);

  if (!editing) {
    return (
      <div className="grid gap-1 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-800">{def.name}</span>
          {roleBadge}
          <span className="ml-auto font-mono text-[11px] text-zinc-400">{def.oid}</span>
        </div>
        {description ? <p className="text-xs text-zinc-500">{description}</p> : null}
        {expression ? (
          <code className="w-fit rounded bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-700">
            {expression}
          </code>
        ) : (
          <p className="text-xs text-amber-600">
            No jsonata expression: this rule is inert at runtime.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-2 py-3">
      <div className="flex items-center gap-2">
        <Input
          value={def.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          className="max-w-sm"
        />
        {roleBadge}
        <span className="ml-auto font-mono text-[11px] text-zinc-400">{def.oid}</span>
        <button
          type="button"
          aria-label="Remove rule"
          title={refCount > 0 ? `In use by ${refCount} reference(s)` : "Remove"}
          disabled={refCount > 0}
          onClick={onRemove}
          className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-300"
        >
          ✕
        </button>
      </div>
      <Input
        value={description ?? ""}
        placeholder="Description (shown as the query message when the rule fires)"
        onChange={(e) => onPatch({ description: e.target.value })}
      />
      <input
        value={expression ?? ""}
        placeholder="jsonata expression, e.g. `IT.DM.SEX` = 'M'"
        onChange={(e) => onPatch({ expression: e.target.value === "" ? null : e.target.value })}
        className={expressionClass}
      />
      <SyntaxNote code={expression} />
    </div>
  );
}

export function RulesPanel({
  mdv,
  editing,
  onChange,
}: {
  mdv: MetaDataVersion;
  editing: boolean;
  onChange: (mdv: MetaDataVersion) => void;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section>
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-900">Conditions</h3>
          {editing ? (
            <Button
              variant="secondary"
              onClick={() => onChange(addConditionDef(mdv, { name: "New condition" }).mdv)}
            >
              + Condition
            </Button>
          ) : null}
        </div>
        <p className="mb-2 text-xs text-zinc-500">
          Wired to a field, section, or option as skip logic, a condition hides its target while
          true. Unwired conditions run as edit checks and raise a query when true.
        </p>
        <div className="divide-y divide-zinc-100">
          {mdv.conditionDefs.length === 0 ? (
            <p className="py-3 text-sm text-zinc-400">No conditions defined.</p>
          ) : (
            mdv.conditionDefs.map((def) => {
              const refCount = conditionReferenceCount(mdv, def.oid);
              return (
                <RuleRow
                  key={def.oid}
                  def={def}
                  refCount={refCount}
                  roleBadge={
                    refCount > 0 ? (
                      <Badge tone="amber">skip logic · {refCount}</Badge>
                    ) : (
                      <Badge tone="emerald">edit check</Badge>
                    )
                  }
                  editing={editing}
                  onPatch={(patch) => onChange(updateConditionDef(mdv, def.oid, patch))}
                  onRemove={() => onChange(removeConditionDef(mdv, def.oid))}
                />
              );
            })
          )}
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-900">Methods</h3>
          {editing ? (
            <Button
              variant="secondary"
              onClick={() => onChange(addMethodDef(mdv, { name: "New method" }).mdv)}
            >
              + Method
            </Button>
          ) : null}
        </div>
        <p className="mb-2 text-xs text-zinc-500">
          A method computes a derived value from other fields. Assign it to a field in the form
          editor; the server writes the value and entry is disabled.
        </p>
        <div className="divide-y divide-zinc-100">
          {mdv.methodDefs.length === 0 ? (
            <p className="py-3 text-sm text-zinc-400">No methods defined.</p>
          ) : (
            mdv.methodDefs.map((def) => {
              const refCount = methodReferenceCount(mdv, def.oid);
              return (
                <RuleRow
                  key={def.oid}
                  def={def}
                  refCount={refCount}
                  roleBadge={
                    <Badge tone="sky">derivation{refCount > 0 ? ` · ${refCount}` : ""}</Badge>
                  }
                  editing={editing}
                  onPatch={(patch) => onChange(updateMethodDef(mdv, def.oid, patch))}
                  onRemove={() => onChange(removeMethodDef(mdv, def.oid))}
                />
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
