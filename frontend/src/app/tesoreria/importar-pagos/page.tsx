"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

type Row = { id: string; rowNumber: number; documento: string; amount: number; method: string; reference: string | null; date: string | null; status: string; message: string | null };
type Batch = {
  id: string; fileName: string | null; status: string; date: string;
  totalRows: number; appliedRows: number; errorRows: number; notFoundRows: number; duplicateRows: number;
  totalAmount: number; appliedAmount: number; rows?: Row[];
};

const STATUS_TONE: Record<string, "default" | "success" | "error" | "warning"> = {
  Inicial: "default", Cargado: "success", Error: "error", "Usuario No Existe": "warning", Duplicado: "warning",
};

function fmtDate(d?: string | null) {
  return d ? new Date(d + (d.length <= 10 ? "T00:00:00" : "")).toLocaleDateString("es-CO") : "—";
}

export default function ImportarPagosPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [current, setCurrent] = useState<Batch | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try { setBatches(await (await authFetch("/payment-imports")).json()); }
    catch { toast("No se pudieron cargar los lotes", "alert-triangle"); }
    finally { setLoading(false); }
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void loadList(); }, [authLoading, loadList]);

  async function openBatch(id: string) {
    try { setCurrent(await (await authFetch(`/payment-imports/${id}`)).json()); }
    catch { toast("No se pudo abrir el lote", "alert-triangle"); }
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { toast("Selecciona un archivo .xlsx", "alert-triangle"); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (date) fd.append("date", date);
      const res = await authFetch("/payment-imports/upload", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo cargar el archivo");
      setCurrent(d);
      if (fileRef.current) fileRef.current.value = "";
      toast(`Archivo cargado · ${d.totalRows} fila(s)`, "check");
      void loadList();
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setBusy(false); }
  }

  async function process() {
    if (!current) return;
    if (!confirm(`Se aplicarán ${current.totalRows} pago(s) a la cartera de los clientes. Los clientes cortados que paguen serán reconectados. ¿Continuar?`)) return;
    setBusy(true);
    try {
      const res = await authFetch(`/payment-imports/${current.id}/process`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo procesar");
      setCurrent(d);
      toast(`Procesado · ${d.appliedRows} aplicado(s), ${d.errorRows + d.notFoundRows} con problema`, "check");
      void loadList();
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setBusy(false); }
  }

  async function discard(id: string) {
    if (!confirm("¿Eliminar este lote? Los pagos ya aplicados NO se revierten.")) return;
    try {
      const res = await authFetch(`/payment-imports/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast("Lote eliminado", "check");
      if (current?.id === id) setCurrent(null);
      void loadList();
    } catch { toast("No se pudo eliminar", "alert-triangle"); }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="upload" title="Importar pagos (Efecty)" subtitle="Carga masiva de pagos externos y aplicación automática a cartera" />

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <h2 className="mb-1 text-[13px] font-bold text-text-primary">Cargar archivo</h2>
        <p className="mb-3 text-[12px] text-text-tertiary">
          Excel <strong>.xlsx</strong> con encabezado en la fila 1 y datos desde la fila 2. Columnas:
          <span className="mono"> A</span> Fecha · <span className="mono">B</span> Documento/Abonado · <span className="mono">C</span> Monto · <span className="mono">D</span> Método · <span className="mono">E</span> Referencia.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[240px] flex-1">
            <label className="mb-1 block text-[11px] font-semibold uppercase text-text-tertiary">Archivo .xlsx</label>
            <input ref={fileRef} type="file" accept=".xlsx" className="block w-full text-[13px] text-text-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-[12px] file:font-semibold file:text-brand" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase text-text-tertiary">Forzar fecha (opcional)</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <Button variant="primary" onClick={upload} disabled={busy}><Icon name="upload" size={15} /> {busy ? "Cargando…" : "Cargar"}</Button>
        </div>
      </div>

      {current && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[13px] font-bold text-text-primary">{current.fileName ?? "Lote"} <Badge label={current.status} tone={current.status === "Procesado" ? "success" : "warning"} /></h2>
              <p className="text-[12px] text-text-tertiary">{current.totalRows} fila(s) · total {cop(current.totalAmount)} · aplicado {cop(current.appliedAmount)}</p>
            </div>
            <div className="flex gap-2">
              {current.status !== "Procesado" && <Button variant="primary" onClick={process} disabled={busy}><Icon name="check" size={15} /> {busy ? "Procesando…" : "Procesar pagos"}</Button>}
              <Button variant="ghost" onClick={() => discard(current.id)}><Icon name="trash" size={15} /> Descartar</Button>
            </div>
          </div>

          {current.status === "Procesado" && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-border-subtle p-2 text-center"><div className="text-[18px] font-bold text-success-text">{current.appliedRows}</div><div className="text-[11px] text-text-tertiary">Aplicados</div></div>
              <div className="rounded-lg border border-border-subtle p-2 text-center"><div className="text-[18px] font-bold text-warning-text">{current.notFoundRows}</div><div className="text-[11px] text-text-tertiary">Sin cliente</div></div>
              <div className="rounded-lg border border-border-subtle p-2 text-center"><div className="text-[18px] font-bold text-warning-text">{current.duplicateRows}</div><div className="text-[11px] text-text-tertiary">Duplicados</div></div>
              <div className="rounded-lg border border-border-subtle p-2 text-center"><div className="text-[18px] font-bold text-error-text">{current.errorRows}</div><div className="text-[11px] text-text-tertiary">Con error</div></div>
            </div>
          )}

          <DataTable
            rows={current.rows ?? []}
            empty="Sin filas."
            columns={[
              { key: "rowNumber", header: "#", render: (r: Row) => <span className="text-text-tertiary">{r.rowNumber}</span> },
              { key: "documento", header: "Documento", render: (r: Row) => <span className="font-medium text-text-primary">{r.documento}</span> },
              { key: "amount", header: "Monto", align: "right", render: (r: Row) => cop(r.amount) },
              { key: "method", header: "Método", render: (r: Row) => <span className="text-text-secondary">{r.method}</span> },
              { key: "reference", header: "Referencia", render: (r: Row) => <span className="text-[12px] text-text-tertiary">{r.reference ?? "—"}</span> },
              { key: "date", header: "Fecha", render: (r: Row) => <span className="text-text-secondary">{fmtDate(r.date)}</span> },
              { key: "status", header: "Estado", render: (r: Row) => <Badge label={r.status} tone={STATUS_TONE[r.status] ?? "default"} /> },
              { key: "message", header: "Detalle", render: (r: Row) => <span className="text-[12px] text-text-tertiary">{r.message ?? "—"}</span> },
            ]}
          />
        </div>
      )}

      <div>
        <h2 className="mb-2 text-[13px] font-bold text-text-primary">Cargues recientes</h2>
        {loading ? <PageSkeleton /> : (
          <DataTable
            rows={batches}
            empty="Aún no hay cargues de pagos."
            columns={[
              { key: "fileName", header: "Archivo", render: (b: Batch) => <button onClick={() => openBatch(b.id)} className="font-medium text-brand hover:underline">{b.fileName ?? "—"}</button> },
              { key: "date", header: "Fecha", render: (b: Batch) => <span className="text-text-secondary">{fmtDate(b.date)}</span> },
              { key: "status", header: "Estado", render: (b: Batch) => <Badge label={b.status} tone={b.status === "Procesado" ? "success" : "warning"} /> },
              { key: "totalRows", header: "Filas", align: "right", render: (b: Batch) => b.totalRows },
              { key: "appliedRows", header: "Aplicados", align: "right", render: (b: Batch) => <span className="text-success-text">{b.appliedRows}</span> },
              { key: "appliedAmount", header: "Monto aplicado", align: "right", render: (b: Batch) => cop(b.appliedAmount) },
              { key: "acc", header: "", align: "right", render: (b: Batch) => <button onClick={() => discard(b.id)} className="text-text-tertiary hover:text-error-text" title="Eliminar"><Icon name="trash" size={15} /></button> },
            ]}
          />
        )}
      </div>
    </>
  );
}
