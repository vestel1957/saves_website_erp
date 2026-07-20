"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

type Folder = { id: string; name: string; count: number };
type Doc = { id: string; title: string; fileName: string | null; folderId: string | null; docDate: string | null; downloadable: boolean; createdAt: string };

export default function DocumentosPage() {
  const { authFetch } = useAuth();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState("");
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

  const folderName = (id: string | null) => folders.find((f) => f.id === id)?.name ?? "Sin carpeta";

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

      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border-subtle text-left text-text-tertiary">
              <th className="py-2 pl-3 pr-3 font-medium">Título</th>
              <th className="py-2 pr-3 font-medium">Archivo</th>
              <th className="py-2 pr-3 font-medium">Carpeta</th>
              <th className="py-2 pr-3 font-medium">Fecha</th>
              <th className="py-2 pr-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 ? (
              <tr><td colSpan={5} className="py-6 text-center text-text-tertiary">Sin documentos.</td></tr>
            ) : docs.map((d) => (
              <tr key={d.id} className="border-b border-border-subtle/60">
                <td className="py-1.5 pl-3 pr-3 font-medium">{d.title}</td>
                <td className="py-1.5 pr-3 text-text-secondary">{d.fileName ?? "—"}</td>
                <td className="py-1.5 pr-3 text-text-tertiary">{folderName(d.folderId)}</td>
                <td className="py-1.5 pr-3 text-text-tertiary">{d.docDate ? new Date(d.docDate).toLocaleDateString("es-CO") : new Date(d.createdAt).toLocaleDateString("es-CO")}</td>
                <td className="py-1.5 pr-3 text-right">
                  <button onClick={() => download(d)} title={d.downloadable ? "Descargar" : "Solo metadata"} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] ${d.downloadable ? "border-border-default text-text-secondary hover:bg-surface-2" : "border-border-subtle text-text-tertiary"}`}>
                    <Icon name="download" size={13} /> {d.downloadable ? "Descargar" : "—"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
