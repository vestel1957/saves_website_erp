"use client";

import { useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

const ENTITIES = [
  { key: "subscribers", label: "Clientes", icon: "users" },
  { key: "equipment", label: "Equipos", icon: "boxes" },
  { key: "materials", label: "Materiales", icon: "package" },
  { key: "invoices", label: "Facturas", icon: "receipt" },
];

export default function DatosPage() {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [importing, setImporting] = useState(false);

  async function exportEntity(entity: string) {
    setBusy(entity);
    try {
      const res = await authFetch(`/data/export/${entity}`);
      if (!res.ok) { toast("No se pudo exportar", "x"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${entity}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(null); }
  }

  async function runImport(commit: boolean) {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetch(`/data/import/equipment${commit ? "?commit=1" : ""}`, { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) { toast(d?.message ?? "Error al importar", "x"); return; }
      setPreview(d);
      if (commit) toast(`Importados ${d.created} equipos`, "check");
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setImporting(false); }
  }

  return (
    <div className="space-y-5">
      <PageHeading icon="file-spreadsheet" title="Importar / Exportar" subtitle="Descarga y cargue masivo por Excel (migrado de Import/Export)." />

      {/* Export */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-text-primary">Exportar a Excel</h3>
        <div className="flex flex-wrap gap-2">
          {ENTITIES.map((e) => (
            <Button key={e.key} variant="secondary" disabled={busy !== null} onClick={() => exportEntity(e.key)}>
              <Icon name={e.icon} size={15} /> {busy === e.key ? "Generando…" : e.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Import */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <h3 className="mb-1 text-[13px] font-semibold text-text-primary">Importar equipos desde Excel</h3>
        <p className="mb-3 text-[12px] text-text-tertiary">Columnas: Código · MAC · Serial · Marca · Estado. Primero valida (vista previa); luego confirma.</p>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
            className="text-[13px] file:mr-3 file:rounded-lg file:border file:border-border-default file:bg-surface-2 file:px-3 file:py-1.5 file:text-[13px]" />
          <Button variant="secondary" disabled={!file || importing} onClick={() => runImport(false)}>
            {importing ? "Validando…" : "Validar (vista previa)"}
          </Button>
          {preview && preview.validCount > 0 && (
            <Button disabled={importing} onClick={() => runImport(true)}>
              <Icon name="upload" size={15} /> Confirmar {preview.validCount} equipos
            </Button>
          )}
        </div>

        {preview && (
          <div className="mt-4 rounded-lg border border-border-subtle bg-surface-subtle p-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              {preview.committed
                ? <Badge label={`${preview.created} creados`} tone="success" />
                : <Badge label="Vista previa" tone="warning" />}
              <span className="text-text-secondary">{preview.totalRows} filas · <b className="text-success-text">{preview.validCount} válidas</b> · <b className="text-error-text">{preview.errorCount} con error</b></span>
            </div>
            {preview.sample?.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-text-tertiary"><th className="pr-3">Código</th><th className="pr-3">MAC</th><th className="pr-3">Serial</th><th className="pr-3">Marca</th><th>Estado</th></tr></thead>
                  <tbody>
                    {preview.sample.map((s: any, i: number) => (
                      <tr key={i} className="border-t border-border-subtle/60"><td className="pr-3 font-mono">{s.code ?? "—"}</td><td className="pr-3 font-mono">{s.mac ?? "—"}</td><td className="pr-3">{s.serial ?? "—"}</td><td className="pr-3">{s.brand ?? "—"}</td><td>{s.status}</td></tr>
                    ))}
                  </tbody>
                </table>
                {preview.validCount > preview.sample.length && <p className="mt-1 text-[11px] text-text-tertiary">…y {preview.validCount - preview.sample.length} más.</p>}
              </div>
            )}
            {preview.errors?.length > 0 && (
              <ul className="mt-2 text-[12px] text-error-text">
                {preview.errors.map((e: any, i: number) => <li key={i}>Fila {e.row}: {e.reason}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
