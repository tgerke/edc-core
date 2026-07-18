import {
  type CodeList,
  displayText,
  type ItemDef,
  type ResolvedGroup,
  type ResolvedItem,
} from "@edc-core/odm";
import { Badge } from "./ui.js";

/**
 * Read-only live preview of a form rendered purely from study metadata —
 * the embryo of the Phase 3 capture renderer. Field widgets are chosen
 * from ItemDef DataType + CodeList presence, exactly as capture will.
 */

function FieldControl({ def, codeList }: { def: ItemDef; codeList?: CodeList | undefined }) {
  const base =
    "w-full max-w-sm rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500";

  if (codeList) {
    if (codeList.items.length <= 5) {
      return (
        <div className="flex flex-wrap gap-2">
          {codeList.items.map((item) => (
            <span
              key={item.codedValue}
              className="flex cursor-default items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700"
              title={
                item.collectionExceptionConditionOid
                  ? `Shown conditionally (${item.collectionExceptionConditionOid})`
                  : undefined
              }
            >
              <span className="size-3.5 rounded-full border border-zinc-300" />
              {displayText(item.decode) ?? item.codedValue}
              {item.collectionExceptionConditionOid ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-amber-600">
                  cond
                </span>
              ) : null}
            </span>
          ))}
        </div>
      );
    }
    const conditional = codeList.items.filter((i) => i.collectionExceptionConditionOid).length;
    return (
      <select className={base} disabled>
        <option>
          {`Select… (${codeList.items.length} options${conditional > 0 ? `, ${conditional} conditional` : ""})`}
        </option>
      </select>
    );
  }

  switch (def.dataType) {
    case "boolean":
      return (
        <span className="flex items-center gap-2 text-sm text-zinc-700">
          <span className="size-4 rounded border border-zinc-300 bg-white" />
          Yes
        </span>
      );
    case "date":
      return <input type="date" className={base} disabled />;
    case "datetime":
      return <input type="datetime-local" className={base} disabled />;
    case "integer":
    case "float":
    case "double":
    case "decimal":
      return <input type="number" className={base} disabled placeholder="0" />;
    default:
      return (
        <input
          type="text"
          className={base}
          disabled
          placeholder={def.length ? `text (max ${def.length})` : "text"}
        />
      );
  }
}

function ItemRow({ item }: { item: ResolvedItem }) {
  const label =
    displayText(item.def.question) ?? displayText(item.def.description) ?? item.def.name;
  return (
    <div className="grid gap-1.5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-800">{label}</span>
        {item.ref.mandatory === "Yes" ? <span className="text-rose-500">*</span> : null}
        {item.ref.methodOid ? <Badge tone="sky">computed</Badge> : null}
        {item.ref.collectionExceptionConditionOid ? <Badge tone="amber">conditional</Badge> : null}
        <span className="ml-auto font-mono text-[11px] text-zinc-400">{item.def.oid}</span>
      </div>
      <FieldControl def={item.def} codeList={item.codeList} />
    </div>
  );
}

function GroupSection({ group, depth }: { group: ResolvedGroup; depth: number }) {
  const isRepeating = group.def.repeating && group.def.repeating !== "No";
  return (
    <section className={depth > 0 ? "rounded-xl border border-zinc-200 bg-white p-4" : ""}>
      {depth > 0 ? (
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-900">{group.def.name}</h3>
          {isRepeating ? <Badge tone="sky">repeating</Badge> : null}
          {group.ref.collectionExceptionConditionOid ? (
            <Badge tone="amber">conditional</Badge>
          ) : null}
          <span className="ml-auto font-mono text-[11px] text-zinc-400">{group.def.oid}</span>
        </div>
      ) : null}
      <div className="divide-y divide-zinc-100">
        {group.children.map((child, index) =>
          child.kind === "item" ? (
            <ItemRow key={child.def.oid} item={child} />
          ) : (
            <div key={child.def.oid} className={index > 0 ? "pt-3" : ""}>
              <GroupSection group={child} depth={depth + 1} />
            </div>
          ),
        )}
      </div>
    </section>
  );
}

export function FormPreview({ form }: { form: ResolvedGroup }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-zinc-900">{form.def.name}</h2>
        <span className="font-mono text-xs text-zinc-400">{form.def.oid}</span>
      </div>
      <GroupSection group={form} depth={0} />
    </div>
  );
}
