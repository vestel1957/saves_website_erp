"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { type Column } from "@/components/ui/DataTable";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { useAuth } from "@/context/AuthProvider";

type Folder = { id: string; name: string; count: number };
type Doc = { id: string; title: string; fileName: string | null; folderId: string | null; docDate: string | null; downloadable: boolean; createdAt: string };

export default function DocumentosPage() {
  const { authFetch } = useAuth();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    void authFetch(`/extras/documents`).then((r) => (r.ok ? r.json() : { folders: [], documents: [] }))
      .then((d) => { setFolders(d.folders); setDocs(d.documents); }).catch(() => {});
  }, [authFetch]);
  useEffect(() => { load(); }, [load]);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { toast("Selecciona un archivo", "x"); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (title.trim()) fd.append("title", title.trim());
      const res = await authFetch(`/extras/documents`, { method: "POST", body: fd });
      if (!res.ok) { toast("No se pudo subir", "x"); return; }
      toast("Documento subido", "check");
      setTitle(""); if (fileRef.current) fileRef.current.value = "";
      load();
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setUploading(false); }
  }

  async function download(d: Doc) {
    if (!d.downloadable) { toast("Documento migrado sin archivo (solo metadata)", "x"); return; }
    const res = await authFetch(`/extras/documents/${d.id}/download`);
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a"); a.href = url; a.download = d.fileName ?? d.title; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  const folderName = useCallback((id: string | null) => folders.find((f) => f.id === id)?.name ?? "Sin carpeta", [folders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) =>
      d.title.toLowerCase().includes(q) ||
      (d.fileName ?? "").toLowerCase().includes(q) ||
      folderName(d.folderId).toLowerCase().includes(q),
    );
  }, [docs, search, folderName]);

  const columns: Column<Doc>[] = [
    { key: "title", header: "Título", render: (d) => <span className="font-medium">{d.title}</span> },
    { key: "fileName", header: "Archivo", render: (d) => <span className="text-text-secondary">{d.fileName ?? "—"}</span> },
    { key: "folder", header: "Carpeta", render: (d) => <span className="text-text-tertiary">{folderName(d.folderId)}</span> },
    { key: "date", header: "Fecha", render: (d) => <span className="text-text-tertiary">{d.docDate ? new Date(d.docDate).toLocaleDateString("es-CO") : new Date(d.createdAt).toLocaleDateString("es-CO")}</span> },
    {
      key: "actions", header: "", align: "right",
      render: (d) => (
        <button onClick={() => download(d)} title={d.downloadable ? "Descargar" : "Solo metadata"} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] ${d.downloadable ? "border-border-default text-text-secondary hover:bg-surface-2" : "border-border-subtle text-text-tertiary"}`}>
          <Icon name="download" size={13} /> {d.downloadable ? "Descargar" : "—"}
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeading icon="folder" title="Documentos" subtitle="Biblioteca documental de Vestel (documents/folders)." />

      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border-subtle bg-surface p-3">
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Título (opcional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nombre del documento" className="rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[13px]" />
        </label>
        <input ref={fileRef} type="file" className="text-[13px] file:mr-3 file:rounded-lg file:border file:border-border-default file:bg-surface-2 file:px-3 file:py-1.5" />
        <Button disabled={uploading} onClick={upload}><Icon name="upload" size={15} /> {uploading ? "Subiendo…" : "Subir documento"}</Button>
      </div>

      {folders.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {folders.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-[12px]">
              <Icon name="folder" size={14} className="text-brand" /> {f.name} <b>{f.count}</b>
            </span>
          ))}
        </div>
      )}

      <div>
        <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por título, archivo o carpeta…" />
        <PagedTable columns={columns} rows={filtered} empty="Sin documentos." />
      </div>
    </div>
  );
}
