"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Row = {
  id: string; rowNumber: number; documento: string; amount: number; method: string;
  reference: string | null; date: string | null; status: string;
  subscriberId: string | null; subscriberName: string | null; message: string | null;
};
type Metodo = { method: string; rows: number; account: string | null };
type Batch = {
  id: string; fileName: string | null; status: string; date: string; mode: string;
  user: string | null; hasFile: boolean;
  /** Cargue hecho en el sistema anterior: sólo se consulta (ver PaymentImportsService). */
  legacy?: boolean;
  totalRows: number; appliedRows: number; errorRows: number; notFoundRows: number; duplicateRows: number;
  totalAmount: number; appliedAmount: number; pendientes?: number;
  metodos?: Metodo[]; rows?: Row[];
};

/**
 * Modos del selector, calcados del legacy (`transactions/cargar_desde_excel`):
 *   "Cambiar Fecha"  → todas las filas se registran con la fecha que se escriba.
 *   "No Cambiar fecha" → cada fila lleva la fecha de su columna A.
 *   "…actualizar paquete…" → el archivo no trae plata: cambia el plan de la
 *   última factura del cliente.
 */
const MODOS = [
  { value: "fecha", label: "Cambiar fecha" },
  { value: "archivo", label: "No cambiar fecha (la del archivo)" },
  { value: "plan", label: "Actualizar el paquete de la última factura" },
] as const;
type Modo = (typeof MODOS)[number]["value"];

const STATUS_TONE: Record<string, "default" | "success" | "error" | "warning"> = {
  Inicial: "default", Cargado: "success", Error: "error", "Usuario No Existe": "warning", Duplicado: "warning",
};

/** Tamaño de la tanda: el proceso avanza de 25 en 25 para poder pintar el avance. */
const TANDA = 25;

function fmtDate(d?: string | null) {
  return d ? new Date(d + (d.length <= 10 ? "T00:00:00" : "")).toLocaleDateString("es-CO") : "—";
}

/** Barra de avance (el `LineProgressbar` del legacy). */
function Barra({ pct, tone = "brand" }: { pct: number; tone?: "brand" | "success" }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-subtle">
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${tone === "success" ? "bg-success-text" : "bg-brand"}`}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

export default function ImportarPagosPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [current, setCurrent] = useState<Batch | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modo, setModo] = useState<Modo>("fecha");
  const [date, setDate] = useState("");
  const [rowSearch, setRowSearch] = useState("");
  const [listSearch, setListSearch] = useState("");
  const [abierto, setAbierto] = useState(false);
  const [porBorrar, setPorBorrar] = useState<Batch | null>(null);
  // Avance del proceso: filas hechas / total y en qué anda la tanda actual.
  const [avance, setAvance] = useState<{ hechas: number; total: number; activo: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const filas = current?.rows ?? [];
  const aplicadas = useMemo(() => filas.filter((r) => r.status === "Cargado"), [filas]);
  const fallidas = useMemo(() => filas.filter((r) => r.status !== "Cargado"), [filas]);

  // Filtro en cliente de las filas del lote abierto (documento, nombre, referencia, estado).
  const filtrar = useCallback((rows: Row[]) => {
    const q = rowSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.documento, r.subscriberName, r.reference, r.status, r.message, r.method]
        .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [rowSearch]);

  /** Filtro del historial: nombre del archivo, quién lo subió o la fecha. */
  const listados = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return batches;
    return batches.filter((b) =>
      [b.fileName, b.user, fmtDate(b.date), b.status].some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [batches, listSearch]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try { setBatches(await (await authFetch("/payment-imports")).json()); }
    catch { toast("No se pudieron cargar los lotes", "alert-triangle"); }
    finally { setLoading(false); }
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void loadList(); }, [authLoading, loadList]);

  async function abrirLote(id: string) {
    try {
      const d: Batch = await (await authFetch(`/payment-imports/${id}`)).json();
      setCurrent(d);
      setAvance({ hechas: d.totalRows - (d.pendientes ?? 0), total: d.totalRows, activo: false });
      setAbierto(true);
      return d;
    } catch { toast("No se pudo abrir el lote", "alert-triangle"); return null; }
  }

  async function subir() {
    const file = fileRef.current?.files?.[0];
    if (!file) { toast("Selecciona un archivo .xlsx", "alert-triangle"); return; }
    if (modo === "fecha" && !date) { toast("Escribe la fecha con la que se van a registrar los pagos", "alert-triangle"); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mode", modo === "plan" ? "plan" : "pagos");
      if (modo === "fecha" && date) fd.append("date", date);
      const res = await authFetch("/payment-imports/upload", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo cargar el archivo");
      setCurrent(d);
      setAvance({ hechas: d.totalRows - (d.pendientes ?? 0), total: d.totalRows, activo: false });
      setAbierto(true);
      if (fileRef.current) fileRef.current.value = "";
      toast(`Archivo cargado · ${d.totalRows} fila(s)`, "check");
      void loadList();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
  }

  /**
   * Procesa el lote por tandas, como el legacy: cada vuelta aplica unas cuantas
   * filas y devuelve el lote actualizado, así la pantalla puede ir contando.
   */
  async function procesar(batch: Batch) {
    const total = batch.totalRows;
    let hechas = total - (batch.pendientes ?? total);
    setAvance({ hechas, total, activo: true });
    setBusy(true);
    let ultimo: any = null;
    try {
      // Tope de vueltas: si algo dejara de avanzar, se corta en vez de girar sin fin.
      for (let i = 0; i < Math.ceil(total / TANDA) + 2; i++) {
        const res = await authFetch(`/payment-imports/${batch.id}/process?limit=${TANDA}`, { method: "POST" });
        const d = await res.json();
        if (!res.ok) throw new Error(d?.message || "No se pudo procesar");
        ultimo = d;
        setCurrent(d);
        hechas = total - (d.pendientes ?? 0);
        setAvance({ hechas, total, activo: (d.pendientes ?? 0) > 0 });
        if (!d.pendientes) break;
      }
      if (ultimo) {
        toast(`Proceso finalizado · ${ultimo.appliedRows} aplicado(s), ${ultimo.errorRows + ultimo.notFoundRows} con problema`, "check");
        // La reconexión va aparte del pago: puede aplicar todo y aun así dejar a
        // alguien cortado si el router o la OLT no contestaron. Eso se dice, no se calla.
        const r = ultimo.reconexion;
        if (r?.total) {
          const detalle = `${r.internet} internet · ${r.tv} TV${r.dryRun ? " (simulado)" : ""}`;
          if (r.ordenes) toast(`${r.fallidos} cliente(s) siguen sin servicio (${detalle}): quedaron ${r.ordenes} orden(es) de visita.`, "clipboard-list");
          else if (r.fallidos) toast(`OJO: ${r.fallidos} cliente(s) pagaron y NO se reconectaron (${detalle}). Reintenta desde Red.`, "alert-triangle");
          else toast(`Servicio reconectado a ${r.total} cliente(s): ${detalle}`, "wifi");
        }
      }
      void loadList();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
    finally { setBusy(false); setAvance((a) => (a ? { ...a, activo: false } : a)); }
  }

  async function reintentar() {
    if (!current) return;
    setBusy(true);
    try {
      const res = await authFetch(`/payment-imports/${current.id}/retry`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo reintentar");
      setCurrent(d);
      setAvance({ hechas: d.totalRows - (d.pendientes ?? 0), total: d.totalRows, activo: false });
      toast(d.pendientes ? `${d.pendientes} fila(s) listas para volver a procesar` : "No quedó ninguna fila recuperable", "refresh-cw");
      void loadList();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
  }

  async function borrar(b: Batch) {
    try {
      const res = await authFetch(`/payment-imports/${b.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast("Cargue eliminado", "check");
      if (current?.id === b.id) { setCurrent(null); setAbierto(false); }
      void loadList();
    } catch { toast("No se pudo eliminar", "alert-triangle"); }
    finally { setPorBorrar(null); }
  }

  async function descargar(b: Batch) {
    try {
      const res = await authFetch(`/payment-imports/${b.id}/file`);
      if (!res.ok) throw new Error("Este cargue no guardó el archivo original.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = b.fileName ?? "cargue.xlsx";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  }

  const sinCuenta = (current?.metodos ?? []).filter((m) => !m.account);
  const pct = avance && avance.total ? (avance.hechas * 100) / avance.total : 0;

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading icon="upload" title="Importar pagos" subtitle="Cargue masivo de recaudos de corresponsal (Efecty, Bancolombia) y aplicación automática a cartera" />

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <h2 className="mb-1 text-[13px] font-bold text-text-primary">Selecciona el archivo y súbelo</h2>
        <p className="mb-3 text-[12px] text-text-tertiary">
          {modo === "plan" ? (
            <>Excel <strong>.xlsx</strong> con encabezado en la fila 1. Columnas: <span className="mono">A</span> id del cliente · <span className="mono">B</span> documento · <span className="mono">E</span> código del plan/producto. No mueve plata: cambia el paquete de la última factura.</>
          ) : (
            <>Excel <strong>.xlsx</strong> con encabezado en la fila 1 y datos desde la fila 2. Columnas:
              <span className="mono"> A</span> fecha · <span className="mono">B</span> id/abonado/documento · <span className="mono">C</span> monto · <span className="mono">D</span> cuenta donde entra la plata · <span className="mono">E</span> referencia.</>
          )}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px]">
            <label className="mb-1 block text-[11px] font-semibold uppercase text-text-tertiary">Modo</label>
            <Select value={modo} onChange={(e) => setModo(e.target.value as Modo)}>
              {MODOS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
          </div>
          {modo === "fecha" && (
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase text-text-tertiary">Fecha de los pagos</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          )}
          <div className="min-w-[240px] flex-1">
            <label className="mb-1 block text-[11px] font-semibold uppercase text-text-tertiary">Archivo .xlsx</label>
            <input ref={fileRef} type="file" accept=".xlsx" className="block w-full text-[13px] text-text-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-[12px] file:font-semibold file:text-brand" />
          </div>
          <Button variant="primary" onClick={subir} disabled={busy}><Icon name="upload" size={15} /> {busy ? "Cargando…" : "Subir"}</Button>
        </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-bold text-text-primary">Lista de archivos cargados</h2>
          <span className="text-[12px] text-text-tertiary">{listados.length} archivo(s)</span>
        </div>
        <div className="mb-2">
          <ListToolbar search={listSearch} onSearch={setListSearch} searchPlaceholder="Buscar por archivo, usuario o fecha…" />
        </div>
        {loading ? <PageSkeleton /> : (
          <PagedTable
            rows={listados}
            empty={listSearch ? "Ningún cargue coincide con la búsqueda." : "Aún no hay cargues de pagos."}
            columns={[
              {
                key: "fileName", header: "Nombre", render: (b: Batch) => (
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => void abrirLote(b.id)} className="font-medium text-brand hover:underline">{b.fileName ?? "—"}</button>
                    {b.hasFile && (
                      <button onClick={() => void descargar(b)} className="tap text-text-tertiary hover:text-brand" title="Descargar el archivo original">
                        <Icon name="download" size={14} />
                      </button>
                    )}
                    {b.mode === "plan" && <Badge label="paquete" tone="default" />}
                    {b.legacy && <Badge label="anterior" tone="default" />}
                  </div>
                ),
              },
              { key: "date", header: "Fecha", render: (b: Batch) => <span className="text-text-secondary">{fmtDate(b.date)}</span> },
              { key: "user", header: "Usuario", render: (b: Batch) => <span className="text-text-secondary">{b.user ?? "—"}</span> },
              { key: "status", header: "Estado", render: (b: Batch) => <Badge label={b.status === "Procesado" ? "Transacciones cargadas" : "Archivo cargado"} tone={b.status === "Procesado" ? "success" : "warning"} /> },
              { key: "totalRows", header: "Filas", align: "right", render: (b: Batch) => b.totalRows },
              { key: "appliedRows", header: "Aplicados", align: "right", render: (b: Batch) => <span className="text-success-text">{b.appliedRows}</span> },
              { key: "appliedAmount", header: "Monto aplicado", align: "right", render: (b: Batch) => cop(b.appliedAmount) },
              {
                key: "acc", header: "Acción", align: "right", render: (b: Batch) => (
                  b.legacy ? (
                    <div className="flex justify-end">
                      <button onClick={() => void abrirLote(b.id)} className="tap text-text-tertiary hover:text-brand" title="Ver el detalle de este cargue">
                        <Icon name="eye" size={15} />
                      </button>
                    </div>
                  ) : (
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => void abrirLote(b.id).then((d) => { if (d?.pendientes) void procesar(d); })}
                      className="tap text-text-tertiary hover:text-success-text"
                      title="Iniciar el proceso de lectura y generación de transacciones de este archivo"
                    ><Icon name="play" size={15} /></button>
                    <button onClick={() => setPorBorrar(b)} className="tap text-text-tertiary hover:text-error-text" title="Eliminar"><Icon name="trash" size={15} /></button>
                  </div>
                  )
                ),
              },
            ]}
          />
        )}
      </div>

      <Modal open={abierto} onClose={() => setAbierto(false)} title={current?.fileName ?? "Progreso del proceso"} maxWidth="max-w-5xl">
        {current && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] text-text-tertiary">
                {current.totalRows} fila(s) · total {cop(current.totalAmount)} · aplicado {cop(current.appliedAmount)}
                {current.user ? ` · subido por ${current.user}` : ""}
              </p>
              <div className="flex gap-2">
                {!current.legacy && !!current.pendientes && <Button variant="primary" onClick={() => void procesar(current)} disabled={busy}><Icon name="play" size={15} /> {busy ? "Procesando…" : `Procesar ${current.pendientes} fila(s)`}</Button>}
                {!current.legacy && !current.pendientes && (current.errorRows + current.notFoundRows + current.duplicateRows) > 0 && (
                  <Button variant="ghost" onClick={reintentar} disabled={busy}><Icon name="refresh-cw" size={15} /> Reintentar las que fallaron</Button>
                )}
              </div>
            </div>

            {current.legacy && (
              <div className="rounded-lg border border-border-subtle bg-surface-subtle p-3 text-[12px] text-text-secondary">
                Este cargue se hizo en el <strong>sistema anterior</strong>. Está aquí para consulta: los pagos ya quedaron
                registrados y volver a procesarlo los duplicaría.
              </div>
            )}

            {!current.legacy && sinCuenta.length > 0 && (
              <div className="rounded-lg border border-warning-border bg-warning-soft p-3 text-[12px] text-warning-text">
                <strong>Ojo con la columna D.</strong> {sinCuenta.map((m) => `«${m.method}» (${m.rows} fila/s)`).join(", ")} no coincide con ninguna cuenta de tesorería,
                así que esa plata entraría sin cuenta y no cuadraría con el banco. Crea la cuenta con ese nombre exacto en Tesorería ▸ Cajas y cuentas, o corrige el archivo.
              </div>
            )}

            <div>
              <p className="mb-1 text-[12px] font-semibold text-text-secondary">Progreso recorrido usuarios</p>
              <Barra pct={pct} tone={avance?.activo ? "brand" : "success"} />
              <div className="mt-1 text-[11px] text-text-tertiary">{avance ? `${avance.hechas}/${avance.total}` : "0/0"}</div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-border-subtle p-2 text-center"><div className="text-[18px] font-bold text-success-text">{current.appliedRows}</div><div className="text-[11px] text-text-tertiary">Aplicados</div></div>
              <div className="rounded-lg border border-border-subtle p-2 text-center"><div className="text-[18px] font-bold text-warning-text">{current.notFoundRows}</div><div className="text-[11px] text-text-tertiary">Sin cliente</div></div>
              <div className="rounded-lg border border-border-subtle p-2 text-center"><div className="text-[18px] font-bold text-warning-text">{current.duplicateRows}</div><div className="text-[11px] text-text-tertiary">Duplicados</div></div>
              <div className="rounded-lg border border-border-subtle p-2 text-center"><div className="text-[18px] font-bold text-error-text">{current.errorRows}</div><div className="text-[11px] text-text-tertiary">Con error</div></div>
            </div>

            <ListToolbar search={rowSearch} onSearch={setRowSearch} searchPlaceholder="Buscar por documento, nombre, referencia o estado…" />

            <div>
              <h3 className="mb-1 text-[13px] font-bold text-text-primary">Transacciones creadas</h3>
              <PagedTable
                rows={filtrar(aplicadas)}
                defaultPageSize={10}
                empty={rowSearch ? "Ninguna fila coincide con la búsqueda." : "Todavía no se ha aplicado ninguna fila."}
                columns={[
                  { key: "rowNumber", header: "Fila", render: (r: Row) => <span className="text-text-tertiary">{r.rowNumber}</span> },
                  {
                    key: "subscriberName", header: "Nombre", render: (r: Row) => (
                      r.subscriberId
                        ? <a href={`/clientes/${r.subscriberId}`} className="font-medium text-brand hover:underline">{r.subscriberName ?? "Ver cliente"}</a>
                        : <span className="text-text-tertiary">—</span>
                    ),
                  },
                  { key: "documento", header: "Documento", render: (r: Row) => <span className="text-text-secondary">{r.documento}</span> },
                  { key: "amount", header: "Monto", align: "right", render: (r: Row) => cop(r.amount) },
                  { key: "status", header: "Estado", render: (r: Row) => <Badge label={r.status} tone={STATUS_TONE[r.status] ?? "default"} /> },
                  { key: "reference", header: "Referencia", render: (r: Row) => <span className="text-[12px] text-text-tertiary">{r.reference || "—"}</span> },
                  { key: "message", header: "Detalle", render: (r: Row) => <span className="text-[12px] text-text-tertiary">{r.message ?? "—"}</span> },
                ]}
              />
            </div>

            <div>
              <h3 className="mb-1 text-[13px] font-bold text-text-primary">Transacciones no creadas</h3>
              <PagedTable
                rows={filtrar(fallidas)}
                defaultPageSize={10}
                empty={rowSearch ? "Ninguna fila coincide con la búsqueda." : "Ninguna: todas las filas se aplicaron."}
                columns={[
                  { key: "rowNumber", header: "Fila", render: (r: Row) => <span className="text-text-tertiary">{r.rowNumber}</span> },
                  { key: "documento", header: "Documento", render: (r: Row) => <span className="font-medium text-text-primary">{r.documento}</span> },
                  { key: "amount", header: "Monto", align: "right", render: (r: Row) => cop(r.amount) },
                  { key: "status", header: "Estado", render: (r: Row) => <Badge label={r.status} tone={STATUS_TONE[r.status] ?? "default"} /> },
                  { key: "message", header: "Nota", render: (r: Row) => <span className="text-[12px] text-text-tertiary">{r.message ?? "—"}</span> },
                  { key: "method", header: "Método de pago", render: (r: Row) => <span className="text-text-secondary">{r.method || "—"}</span> },
                  { key: "date", header: "Fecha", render: (r: Row) => <span className="text-text-secondary">{fmtDate(r.date)}</span> },
                ]}
              />
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!porBorrar}
        title="Eliminar el cargue"
        message={<>Se borra el registro del archivo <strong>{porBorrar?.fileName}</strong> y sus filas. Los pagos ya aplicados <strong>NO</strong> se revierten.</>}
        confirmLabel="Eliminar"
        onConfirm={() => porBorrar && borrar(porBorrar)}
        onClose={() => setPorBorrar(null)}
      />
    </>
  );
}
