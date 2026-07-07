import {
  addItem,
  addSection,
  deleteGroup,
  displayText,
  type MetaDataVersion,
  moveItem,
  type ResolvedGroup,
  type ResolvedItem,
  removeItem,
  resolveGroup,
  setItemMandatory,
  updateItemDef,
  updateItemGroup,
} from "@edc-core/odm";
import { useState } from "react";
import { Badge, Button, Input } from "./ui.js";

/**
 * Editable counterpart of FormPreview. Every control applies a pure edit
 * operation from @edc-core/odm to the draft MetaDataVersion and hands the
 * result up; nothing is persisted until the draft is saved as a new build.
 */

const DATA_TYPES = ["text", "integer", "float", "date", "datetime", "boolean"] as const;

const selectClass =
  "rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none";

function IconButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-300"
    >
      {label === "Move up" ? "↑" : label === "Move down" ? "↓" : "✕"}
    </button>
  );
}

function ItemEditor({
  mdv,
  groupOid,
  item,
  first,
  last,
  onChange,
}: {
  mdv: MetaDataVersion;
  groupOid: string;
  item: ResolvedItem;
  first: boolean;
  last: boolean;
  onChange: (mdv: MetaDataVersion) => void;
}) {
  const [open, setOpen] = useState(false);
  const def = item.def;
  const label = displayText(def.question) ?? displayText(def.description) ?? def.name;

  return (
    <div className="py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-800">{label}</span>
        {item.ref.mandatory === "Yes" ? <span className="text-rose-500">*</span> : null}
        <Badge>{def.dataType}</Badge>
        {item.codeList ? <Badge tone="sky">codelist</Badge> : null}
        <span className="ml-auto font-mono text-[11px] text-zinc-400">{def.oid}</span>
        <IconButton
          label="Move up"
          disabled={first}
          onClick={() => onChange(moveItem(mdv, groupOid, def.oid, -1))}
        />
        <IconButton
          label="Move down"
          disabled={last}
          onClick={() => onChange(moveItem(mdv, groupOid, def.oid, 1))}
        />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="rounded px-1.5 py-0.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
        >
          {open ? "Done" : "Edit"}
        </button>
        <IconButton
          label="Remove item"
          onClick={() => onChange(removeItem(mdv, groupOid, def.oid))}
        />
      </div>

      {open ? (
        <div className="mt-2 grid gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 sm:grid-cols-2">
          <label
            htmlFor={`${def.oid}-question`}
            className="grid gap-1 text-xs font-medium text-zinc-500 sm:col-span-2"
          >
            Question
            <Input
              id={`${def.oid}-question`}
              value={displayText(def.question) ?? ""}
              placeholder={def.name}
              onChange={(e) => onChange(updateItemDef(mdv, def.oid, { question: e.target.value }))}
            />
          </label>
          <label
            htmlFor={`${def.oid}-name`}
            className="grid gap-1 text-xs font-medium text-zinc-500"
          >
            Name
            <Input
              id={`${def.oid}-name`}
              value={def.name}
              onChange={(e) => onChange(updateItemDef(mdv, def.oid, { name: e.target.value }))}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-zinc-500">
            Data type
            <select
              className={selectClass}
              value={def.dataType}
              onChange={(e) => onChange(updateItemDef(mdv, def.oid, { dataType: e.target.value }))}
            >
              {DATA_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              {DATA_TYPES.includes(def.dataType as (typeof DATA_TYPES)[number]) ? null : (
                <option value={def.dataType}>{def.dataType}</option>
              )}
            </select>
          </label>
          <label
            htmlFor={`${def.oid}-length`}
            className="grid gap-1 text-xs font-medium text-zinc-500"
          >
            Max length
            <Input
              id={`${def.oid}-length`}
              type="number"
              min={1}
              value={def.length ?? ""}
              placeholder="none"
              onChange={(e) =>
                onChange(
                  updateItemDef(mdv, def.oid, {
                    length: e.target.value === "" ? null : Number(e.target.value),
                  }),
                )
              }
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-zinc-500">
            Codelist
            <select
              className={selectClass}
              value={item.codeList?.oid ?? ""}
              onChange={(e) =>
                onChange(
                  updateItemDef(mdv, def.oid, {
                    codeListOid: e.target.value === "" ? null : e.target.value,
                  }),
                )
              }
            >
              <option value="">none</option>
              {mdv.codeLists.map((cl) => (
                <option key={cl.oid} value={cl.oid}>
                  {cl.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={item.ref.mandatory === "Yes"}
              onChange={(e) => onChange(setItemMandatory(mdv, groupOid, def.oid, e.target.checked))}
            />
            Required
          </label>
        </div>
      ) : null}
    </div>
  );
}

function GroupEditor({
  mdv,
  group,
  depth,
  onChange,
}: {
  mdv: MetaDataVersion;
  group: ResolvedGroup;
  depth: number;
  onChange: (mdv: MetaDataVersion) => void;
}) {
  const items = group.children.filter((c): c is ResolvedItem => c.kind === "item");
  const isRepeating = group.def.repeating != null && group.def.repeating !== "No";

  return (
    <section className={depth > 0 ? "rounded-xl border border-zinc-200 bg-white p-4" : ""}>
      <div className="mb-2 flex items-center gap-2">
        <Input
          value={group.def.name}
          onChange={(e) => onChange(updateItemGroup(mdv, group.def.oid, { name: e.target.value }))}
          className={depth === 0 ? "max-w-md text-lg font-semibold" : "max-w-sm font-medium"}
        />
        {depth > 0 ? (
          <label className="flex items-center gap-1.5 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={isRepeating}
              onChange={(e) =>
                onChange(updateItemGroup(mdv, group.def.oid, { repeating: e.target.checked }))
              }
            />
            repeating
          </label>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-zinc-400">{group.def.oid}</span>
        <Button variant="ghost" onClick={() => onChange(deleteGroup(mdv, group.def.oid))}>
          {depth === 0 ? "Delete form" : "Delete section"}
        </Button>
      </div>

      <div className="divide-y divide-zinc-100">
        {group.children.map((child, index) =>
          child.kind === "item" ? (
            <ItemEditor
              key={child.def.oid}
              mdv={mdv}
              groupOid={group.def.oid}
              item={child}
              first={items[0] === child}
              last={items.at(-1) === child}
              onChange={onChange}
            />
          ) : (
            <div key={child.def.oid} className={index > 0 ? "pt-3" : ""}>
              <GroupEditor mdv={mdv} group={child} depth={depth + 1} onChange={onChange} />
            </div>
          ),
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            onChange(addItem(mdv, group.def.oid, { name: "New item", dataType: "text" }).mdv)
          }
        >
          + Item
        </Button>
        {depth === 0 ? (
          <Button
            variant="secondary"
            onClick={() => onChange(addSection(mdv, group.def.oid, { name: "New section" }).mdv)}
          >
            + Section
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function FormEditor({
  mdv,
  formOid,
  onChange,
}: {
  mdv: MetaDataVersion;
  formOid: string;
  onChange: (mdv: MetaDataVersion) => void;
}) {
  const resolved = resolveGroup(mdv, formOid);
  if (!resolved) {
    return <div className="p-10 text-center text-sm text-zinc-500">Select a form to edit it.</div>;
  }
  return <GroupEditor mdv={mdv} group={resolved} depth={0} onChange={onChange} />;
}
