"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

type Agreement = {
  id: string; subscriberId: string; cliente: string; documento: string | null; abonado: number | null;
  telefono: string | null; estadoCliente: string | null; responsible: string | null;
  date: string | null; dueDate: string | null; vencido: boolean; notes: string | null;
};

function fmtDate(d?: string | null) {
  return d ? new Date(d + "T00:00:00").toLocaleDateString("es-CO") : "—";
}

export default function CobranzaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [rows, setRows] = useState<Agreement[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [confirmar, setConfirmar] = useState<{ kind: "borrar-registro"; row: Agreement } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const buildQuery = useCallback(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    if (state) p.set("state", state);
    if (dueFrom) p.set("dueFrom", dueFrom);
    if (dueTo) p.set("dueTo", dueTo);
    p.set("pageSize", "200");
    return p.toString();
  }, [search, state, dueFrom, dueTo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/collections/agreements?${buildQuery()}`);
      const d = await res.json();
      setRows(d?.items ?? []);
      setTotal(d?.total ?? 0);
    } catch {
      toast("No se pudieron cargar los acuerdos", "alert-triangle");
    } finally { setLoading(false); }
  }, [authFetch, buildQuery]);

  useEffect(() => {
    if (authLoading) return;
    void load();
  }, [authLoading, load]);

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await authFetch(`/collections/agreements/export.csv?${buildQuery()}`);
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `acuerdos-de-pago-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast("No se pudo exportar", "alert-triangle");
    } finally { setExporting(false); }
  }

  async function deleteCall(id: string) {
    setConfirmBusy(true);
    try {
      const res = await authFetch(`/collections/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast("Registro eliminado", "check");
      void load();
    } catch { toast("No se pudo eliminar", "alert-triangle"); }
    finally { setConfirmBusy(false); setConfirmar(null); }
  }

  if (authLoading) return <PageSkeleton />;

  const vencidos = rows.filter((r) => r.vencido).length;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="hand-coins" title="Cobranza · Acuerdos de pago" subtitle={`${total} acuerdo(s) · ${vencidos} vencido(s)`} />
        <Button variant="secondary" onClick={exportCsv} disabled={exporting}>
          <Icon name="download" size={15} /> {exporting ? "Exportando…" : "Exportar CSV"}
        </Button>
      </div>

      {/* La carga sigue siendo manual (Enter o botón «Filtrar»), como antes. */}
      <form onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Cliente o documento">
          <Select value={state} onChange={(e) => setState(e.target.value)} title="Estado">
            <option value="">Todos</option>
            <option value="vigente">Vigentes</option>
            <option value="vencido">Vencidos</option>
          </Select>
          <div className="w-[10rem]"><Input type="date" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} title="Compromiso desde" /></div>
          <div className="w-[10rem]"><Input type="date" value={dueTo} onChange={(e) => setDueTo(e.target.value)} title="Compromiso hasta" /></div>
          <Button type="submit" variant="primary"><Icon name="check" size={15} /> Filtrar</Button>
        </ListToolbar>
      </form>

      {loading ? <PageSkeleton /> : (
        <PagedTable
          rows={rows}
          empty="No hay acuerdos de pago con estos filtros."
          columns={[
            { key: "cliente", header: "Cliente", render: (r: Agreement) => (
              <Link href={`/clientes/${r.subscriberId}`} className="font-medium text-brand hover:underline">
                {r.cliente}
                <span className="block text-[11px] font-normal text-text-tertiary">{r.documento ?? "—"}{r.abonado ? ` · Ab. ${r.abonado}` : ""}</span>
              </Link>
            ) },
            { key: "telefono", header: "Teléfono", render: (r: Agreement) => <span className="text-text-secondary">{r.telefono ?? "—"}</span> },
            { key: "responsible", header: "Responsable", render: (r: Agreement) => <span className="text-text-secondary">{r.responsible ?? "—"}</span> },
            { key: "date", header: "Fecha llamada", render: (r: Agreement) => <span className="text-text-secondary">{fmtDate(r.date)}</span> },
            { key: "dueDate", header: "Compromiso", render: (r: Agreement) => (
              <span className="flex items-center gap-1.5">
                {fmtDate(r.dueDate)}
                {r.vencido ? <Badge label="Vencido" tone="error" /> : <Badge label="Vigente" tone="success" />}
              </span>
            ) },
            { key: "estadoCliente", header: "Estado", render: (r: Agreement) => <Badge label={r.estadoCliente ?? "—"} tone={r.estadoCliente === "COMPROMISO" ? "warning" : "default"} /> },
            { key: "notes", header: "Notas", render: (r: Agreement) => <span className="text-[12px] text-text-tertiary">{r.notes ?? "—"}</span> },
            { key: "acc", header: "", align: "right", render: (r: Agreement) => (
              <button onClick={() => setConfirmar({ kind: "borrar-registro", row: r })} className="tap text-text-tertiary hover:text-error-text" title="Eliminar"><Icon name="trash" size={15} /></button>
            ) },
          ]}
        />
      )}

      {confirmar && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void deleteCall(confirmar.row.id)}
          tone="danger"
          icon="trash"
          title="Eliminar registro de cobranza"
          confirmLabel="Eliminar registro"
          message={
            <>
              Se borra el acuerdo de la bitácora del cliente y deja de constar el compromiso pactado:
              el cliente pierde la protección frente al corte masivo.
            </>
          }
          detail={
            <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
                <dt className="text-text-tertiary">Cliente</dt>
                <dd className="min-w-0 break-words text-right text-text-primary">
                  {confirmar.row.cliente}
                  {confirmar.row.abonado ? <span className="ml-1 font-mono text-text-tertiary">Ab. {confirmar.row.abonado}</span> : null}
                </dd>
                <dt className="text-text-tertiary">Responsable</dt>
                <dd className="text-right text-text-primary">{confirmar.row.responsible ?? "—"}</dd>
                <dt className="text-text-tertiary">Fecha llamada</dt>
                <dd className="text-right text-text-primary">{fmtDate(confirmar.row.date)}</dd>
                <dt className="text-text-tertiary">Compromiso</dt>
                <dd className="flex items-center justify-end gap-1.5 text-right text-text-primary">
                  {fmtDate(confirmar.row.dueDate)}
                  <Badge label={confirmar.row.vencido ? "Vencido" : "Vigente"} tone={confirmar.row.vencido ? "error" : "success"} />
                </dd>
              </dl>
            </div>
          }
        />
      )}
    </>
  );
}
