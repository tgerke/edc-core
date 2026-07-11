import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useDictionaries, useMe, useUploadDictionary } from "../api/hooks.js";
import { Badge, Button, Card, ErrorNote, Input, PageTitle, Spinner } from "../components/ui.js";

/**
 * Global dictionary management — the one non-study admin surface. MedDRA and
 * WHODrug are licensed products; edc-core ships no dictionary content. The
 * server enforces system-admin on every route; the client gate here is just
 * a clear message for everyone else.
 */
export function AdminDictionariesPage() {
  const { data: me } = useMe();
  const isAdmin = me?.isSystemAdmin === true;
  const { data: dictionaries, isPending, isError } = useDictionaries(isAdmin);
  const upload = useUploadDictionary();
  const [type, setType] = useState<"MedDRA" | "WHODrug">("MedDRA");
  const [version, setVersion] = useState("");
  const [uploaded, setUploaded] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  if (!me) return <Spinner />;
  if (!isAdmin) {
    return (
      <Card className="p-10 text-center text-sm text-zinc-500">
        Dictionary management requires a system administrator.
      </Card>
    );
  }

  async function onFile(file: File) {
    setUploaded("");
    const content = await file.text();
    const dictionary = await upload.mutateAsync({ type, version: version.trim(), content });
    setUploaded(`${dictionary.type} ${dictionary.version}: ${dictionary.termsCount} terms loaded`);
    setVersion("");
  }

  return (
    <div>
      <div className="mb-2">
        <Link to="/studies" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← Back to studies
        </Link>
      </div>
      <PageTitle sub="Coding dictionaries are global, versioned reference data shared by every study. Convert your licensed MedDRA (MSSO) or WHODrug (UMC) distribution to the documented CSV layout and upload it here — a new release is a new upload, never an edit.">
        Dictionaries
      </PageTitle>

      <Card className="mb-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "MedDRA" | "WHODrug")}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="MedDRA">MedDRA</option>
            <option value="WHODrug">WHODrug</option>
          </select>
          <Input
            placeholder="Version label (e.g. 27.1)"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            className="w-56"
          />
          <input
            ref={fileInput}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
              e.target.value = "";
            }}
          />
          <Button
            onClick={() => fileInput.current?.click()}
            disabled={version.trim() === "" || upload.isPending}
          >
            {upload.isPending ? "Loading…" : "Upload CSV"}
          </Button>
        </div>
        {upload.isError ? (
          <div className="mt-3">
            <ErrorNote>{upload.error.message}</ErrorNote>
          </div>
        ) : null}
        {uploaded ? <p className="mt-3 text-sm text-emerald-700">{uploaded}</p> : null}
      </Card>

      {isPending ? <Spinner /> : null}
      {isError ? <ErrorNote>Failed to load dictionaries.</ErrorNote> : null}
      {dictionaries && dictionaries.length === 0 ? (
        <Card className="p-10 text-center text-sm text-zinc-500">No dictionaries loaded yet.</Card>
      ) : null}
      {dictionaries && dictionaries.length > 0 ? (
        <Card>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Version</th>
                <th className="px-4 py-3 font-medium">Terms</th>
                <th className="px-4 py-3 font-medium">Loaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {dictionaries.map((dictionary) => (
                <tr key={dictionary.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <Badge tone={dictionary.type === "MedDRA" ? "sky" : "emerald"}>
                      {dictionary.type}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-800">{dictionary.version}</td>
                  <td className="px-4 py-3 text-zinc-600">
                    {dictionary.termsCount.toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-zinc-500">
                    {dictionary.createdBy} · {new Date(dictionary.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
