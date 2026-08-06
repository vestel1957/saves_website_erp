"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Select, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { Modal } from "@/components/Modal";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { accountingApi, type FiscalPeriodRow, type PeriodBalances, type ClosePreview } from "@/lib/accounting";
import { fullCurrency } from "@/lib/format";

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

const ESTADO: Record<string, { etiqueta: string; clase: string }> = {
  OPEN: { etiqueta: "Abierto", clase: "bg-warning-soft text-warning-text" },
  CLOSED: { etiqueta: "Cerrado", clase: "bg-success-soft text-success-text" },
  LOCKED: { etiqueta: "Bloqueado", clase: "bg-surface-2 text-text-secondary" },
};

const fecha = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }) : "—";

/** Los saldos van con signo (deudor +, acreedor −): se pintan por el lado que toca. */
function Saldo({ valor }: { valor: number }) {
  if (!valor) return <span className="text-text-tertiary">—</span>;
  return (
    <span className="font-mono text-[12.5px] text-text-primary">
      {fullCurrency(Math.abs(valor))}
      <span className="ml-1 text-[10px] uppercase text-text-tertiary">{valor > 0 ? "db" : "cr"}</span>
    </span>
  );
}

/**
 * Cierre de mes: el arrastre de saldos de fin de mes.
 *
 * Es el hermano mensual del cierre de caja. Allá, al cerrar el día, el efectivo del
 * cajón queda escrito como un movimiento que reaparece al día siguiente; aquí, al
 * cerrar el mes, el saldo de cada cuenta queda escrito como el punto de partida del mes
 * que entra. Por eso la tabla se lee de izquierda a derecha como una frase: con cuánto
 * entró la cuenta, qué se movió, y con cuánto arranca el mes siguiente.
 *
 * Lo que sí es distinto del de caja —y conviene entender antes de tocar esto— es que
 * las cuentas de resultado (ingresos, costos, gastos) se barren a cero contra Utilidad
 * del ejercicio, mientras que las de balance (banco, clientes, patrimonio) conservan su
 * saldo. Un banco no se vacía porque cambie el mes.
 */
export default function CierresPage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);

  const [periodos, setPeriodos] = useState<FiscalPeriodRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<PeriodBalances | null>(null);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);

  const [previa, setPrevia] = useState<ClosePreview | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [nuevoAbierto, setNuevoAbierto] = useState(false);

  const cargarPeriodos = useCallback(async () => {
    setError(null);
    try {
      const ps = await api.getPeriods();
      setPeriodos(ps);
      // Sin selección, se abre el más reciente: es el que se va a cerrar.
      setSelId((s) => s ?? ps[0]?.id ?? null);
    } catch (e) {
      setError(mensajeDeError(e));
    }
  }, [api]);

  useEffect(() => { void cargarPeriodos(); }, [cargarPeriodos]);

  useEffect(() => {
    if (!selId) { setDetalle(null); return; }
    let vivo = true;
    setCargandoDetalle(true);
    api.getPeriodBalances(selId)
      .then((d) => { if (vivo) setDetalle(d); })
      .catch((e) => { if (vivo) toast(mensajeDeError(e), "alert-triangle"); })
      .finally(() => { if (vivo) setCargandoDetalle(false); });
    return () => { vivo = false; };
  }, [api, selId]);

  const refrescar = async (id: string | null) => {
    await cargarPeriodos();
    if (id) setDetalle(await api.getPeriodBalances(id).catch(() => null));
  };

  /** Pide la vista previa y abre el modal: cerrar nunca es a ciegas. */
  const pedirCierre = async (id: string) => {
    setTrabajando(true);
    try {
      setPrevia(await api.previewClose(id));
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setTrabajando(false); }
  };

  const cerrar = async () => {
    if (!previa) return;
    setTrabajando(true);
    try {
      const r = await api.closePeriod(previa.periodo.id);
      toast(
        r.asientoCierre
          ? `${r.name} cerrado · asiento #${r.asientoCierre.number} · ${r.cuentasArrastradas} cuentas arrastradas`
          : `${r.name} cerrado (sin movimientos que cancelar)`,
        "check",
      );
      setPrevia(null);
      await refrescar(previa.periodo.id);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setTrabajando(false); }
  };

  const reabrir = async (p: FiscalPeriodRow) => {
    setTrabajando(true);
    try {
      await api.reopenPeriod(p.id);
      toast(`${p.name} reabierto: se borró su asiento de cierre`, "check");
      await refrescar(p.id);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setTrabajando(false); }
  };

  if (!periodos && !error) return <PageSkeleton />;
  if (error) return <div className="p-6"><LoadError message={error} onRetry={() => void cargarPeriodos()} /></div>;

  const sel = periodos?.find((p) => p.id === selId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="calendar"
          title="Cierre de mes"
          subtitle="Con el saldo que deja un mes arranca el siguiente"
        />
        <Button size="sm" variant="secondary" onClick={() => setNuevoAbierto(true)}>
          <Icon name="plus" size={14} /> Abrir un mes
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        {/* Los meses, del más reciente al más viejo. */}
        <div className="flex flex-col gap-2">
          {periodos?.length === 0 && (
            <div className="rounded-xl border border-dashed border-border-default px-4 py-8 text-center text-[12.5px] text-text-tertiary">
              Todavía no hay meses contables. Abre uno para poder cerrarlo.
            </div>
          )}
          {periodos?.map((p) => {
            const e = ESTADO[p.status] ?? ESTADO.OPEN;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelId(p.id)}
                className={`flex flex-col gap-1 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                  p.id === selId ? "border-brand bg-brand-soft/40" : "border-border-subtle bg-surface hover:bg-surface-2"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-semibold text-text-primary">
                    {p.month ? `${MESES[p.month - 1]} ${p.year}` : `Año ${p.year}`}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${e.clase}`}>{e.etiqueta}</span>
                </span>
                <span className="text-[11.5px] text-text-tertiary">
                  {p.status === "OPEN"
                    ? "Admite asientos"
                    : `Cerrado ${fecha(p.closedAt)}${p.closedBy ? ` · ${p.closedBy}` : ""}`}
                </span>
              </button>
            );
          })}
        </div>

        {/* El arrastre del mes elegido. */}
        <div className="flex min-w-0 flex-col gap-3">
          {!sel ? (
            <div className="rounded-xl border border-dashed border-border-default px-4 py-10 text-center text-[12.5px] text-text-tertiary">
              Elige un mes para ver su arrastre.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[14px] font-bold text-text-primary">
                    {sel.month ? `${MESES[sel.month - 1]} ${sel.year}` : `Año ${sel.year}`}
                  </p>
                  <p className="text-[12px] text-text-tertiary">
                    {detalle?.guardado
                      ? <>Arrastre guardado el {fecha(sel.closedAt)}{detalle.asientoCierre ? <> · asiento de cierre #{detalle.asientoCierre.number}</> : null}</>
                      : "Cifras preliminares: el mes sigue abierto y todavía se mueven"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {sel.status === "OPEN" ? (
                    <Button size="sm" onClick={() => void pedirCierre(sel.id)} disabled={trabajando}>
                      <Icon name="lock" size={14} /> Cerrar el mes
                    </Button>
                  ) : sel.status === "CLOSED" ? (
                    <Button size="sm" variant="secondary" onClick={() => void reabrir(sel)} disabled={trabajando}>
                      <Icon name="rotate-cw" size={14} /> Reabrir
                    </Button>
                  ) : (
                    <span className="text-[12px] font-semibold text-text-tertiary">Bloqueado</span>
                  )}
                </div>
              </div>

              {/* La frase completa: con cuánto entró · qué se movió · con cuánto sale. */}
              <DataTable
                columns={[
                  { key: "code", header: "Código", render: (r: PeriodBalances["items"][number]) => <span className="font-mono text-[12px] text-text-tertiary">{r.code}</span> },
                  { key: "name", header: "Cuenta", render: (r) => <span className="text-[13px] text-text-secondary">{r.name}</span> },
                  { key: "opening", header: "Viene del mes anterior", align: "right", sortValue: (r) => r.opening, render: (r) => <Saldo valor={r.opening} /> },
                  { key: "debit", header: "Débitos", align: "right", sortValue: (r) => r.debit, render: (r) => <span className="font-mono text-[12.5px] text-text-secondary">{r.debit ? fullCurrency(r.debit) : "—"}</span> },
                  { key: "credit", header: "Créditos", align: "right", sortValue: (r) => r.credit, render: (r) => <span className="font-mono text-[12.5px] text-text-secondary">{r.credit ? fullCurrency(r.credit) : "—"}</span> },
                  { key: "closing", header: "Pasa al mes siguiente", align: "right", sortValue: (r) => r.closing, render: (r) => <Saldo valor={r.closing} /> },
                ]}
                rows={detalle?.items ?? []}
                loading={cargandoDetalle}
                empty="Este mes no tiene movimientos ni saldos que arrastrar."
              />

              {detalle && detalle.items.length > 0 && (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[
                    { etiqueta: "Viene del mes anterior", valor: detalle.totales.opening },
                    { etiqueta: "Débitos del mes", valor: detalle.totales.debit },
                    { etiqueta: "Créditos del mes", valor: detalle.totales.credit },
                    { etiqueta: "Pasa al mes siguiente", valor: detalle.totales.closing },
                  ].map((c) => (
                    <div key={c.etiqueta} className="rounded-xl border border-border-subtle bg-surface p-3">
                      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">{c.etiqueta}</p>
                      <p className="truncate font-mono text-[14px] font-bold text-text-primary">{fullCurrency(Math.abs(c.valor))}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Los totales de arrastre suman cero cuando la contabilidad cuadra: lo que
                  una cuenta debe, otra lo tiene. Decirlo evita leer la cifra como un error. */}
              {detalle && detalle.items.length > 0 && (
                <p className="text-[11.5px] text-text-tertiary">
                  Las cuentas de resultado (ingresos, costos y gastos) salen en cero: el cierre las lleva a
                  <b> Utilidad del ejercicio</b>, que sí se arrastra. Las de balance conservan su saldo — un banco no
                  se vacía porque cambie el mes.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <ModalCierre
        previa={previa}
        trabajando={trabajando}
        onCerrar={() => void cerrar()}
        onCancelar={() => setPrevia(null)}
      />

      <ModalNuevoMes
        abierto={nuevoAbierto}
        onCerrar={() => setNuevoAbierto(false)}
        onCreado={async (id) => { setNuevoAbierto(false); await cargarPeriodos(); setSelId(id); }}
        crear={(y, m) => api.createPeriod({ year: y, month: m })}
        existentes={periodos ?? []}
      />
    </div>
  );
}

/** Confirmación del cierre: enseña el asiento que se va a escribir ANTES de escribirlo. */
function ModalCierre({
  previa, trabajando, onCerrar, onCancelar,
}: {
  previa: ClosePreview | null; trabajando: boolean; onCerrar: () => void; onCancelar: () => void;
}) {
  const utilidad = previa?.cierre.utilidad ?? 0;
  return (
    <Modal open={!!previa} onClose={onCancelar} title={`Cerrar ${previa?.periodo.name ?? ""}`} maxWidth="max-w-2xl">
      {previa && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-text-secondary">
            Al cerrar se guarda el saldo de <b>{previa.filas.length} cuentas</b> como punto de partida del mes
            siguiente y se bloquean los asientos con fecha dentro del mes. Se puede reabrir.
          </p>

          <div className={`rounded-xl border p-3 ${utilidad >= 0 ? "border-success-border bg-success-soft" : "border-error-border bg-error-soft"}`}>
            <p className={`text-[11px] font-semibold uppercase tracking-wide ${utilidad >= 0 ? "text-success-text" : "text-error-text"}`}>
              {utilidad >= 0 ? "Utilidad del periodo" : "Pérdida del periodo"}
            </p>
            <p className={`font-mono text-[18px] font-bold ${utilidad >= 0 ? "text-success-text" : "text-error-text"}`}>
              {fullCurrency(Math.abs(utilidad))}
            </p>
            <p className="text-[11.5px] text-text-secondary">
              {previa.cierre.cuentaResultado
                ? <>Va a <b>{previa.cierre.cuentaResultado.code} {previa.cierre.cuentaResultado.name}</b>, en patrimonio.</>
                : "⚠ No existe la cuenta 360505: sin ella no se puede cerrar el resultado."}
            </p>
          </div>

          {previa.cierre.lineas.length > 0 ? (
            <div className="max-h-64 overflow-y-auto rounded-xl border border-border-subtle">
              <table className="w-full">
                <thead className="sticky top-0 bg-surface-2 text-[10px] uppercase tracking-wider text-text-tertiary">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Cuenta que se cancela</th>
                    <th className="px-3 py-2 text-right font-semibold">Débito</th>
                    <th className="px-3 py-2 text-right font-semibold">Crédito</th>
                  </tr>
                </thead>
                <tbody>
                  {previa.cierre.lineas.map((l) => (
                    <tr key={l.accountId} className="border-t border-border-subtle">
                      <td className="px-3 py-1.5 text-[12.5px] text-text-secondary">
                        <span className="font-mono text-[11px] text-text-tertiary">{l.code}</span> {l.name}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-[12.5px] text-text-primary">{l.debit ? fullCurrency(l.debit) : "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[12.5px] text-text-primary">{l.credit ? fullCurrency(l.credit) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-text-secondary">
              El mes no tiene resultados que cancelar: se guardará solo el arrastre de saldos.
            </p>
          )}

          {previa.anterior && previa.anterior.status === "OPEN" && (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning-text">
              El mes anterior ({previa.anterior.name}) sigue abierto. Hay que cerrarlo primero: el saldo con el que
              arranca este sale de ese cierre.
            </p>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="secondary" onClick={onCancelar} disabled={trabajando}>Cancelar</Button>
            <Button onClick={onCerrar} disabled={trabajando || (previa.anterior?.status === "OPEN")}>
              {trabajando ? "Cerrando…" : "Cerrar el mes"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Abrir un mes contable. Sin periodo no hay nada que cerrar ni dónde guardar el arrastre. */
function ModalNuevoMes({
  abierto, onCerrar, onCreado, crear, existentes,
}: {
  abierto: boolean; onCerrar: () => void;
  onCreado: (id: string) => void | Promise<void>;
  crear: (year: number, month: number) => Promise<FiscalPeriodRow>;
  existentes: FiscalPeriodRow[];
}) {
  // El año arranca en el del último periodo (o el más reciente que haya): esta pantalla
  // no puede preguntarle la fecha al navegador sin desalinearse del servidor.
  const ultimo = existentes[0];
  const [year, setYear] = useState(ultimo?.year ?? 2026);
  const [month, setMonth] = useState(1);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!abierto || !ultimo) return;
    // Propone el mes siguiente al último abierto, que es lo que se va a querer el 99% de las veces.
    const m = (ultimo.month ?? 12) + 1;
    setYear(m > 12 ? ultimo.year + 1 : ultimo.year);
    setMonth(m > 12 ? 1 : m);
  }, [abierto, ultimo]);

  const guardar = async () => {
    setGuardando(true);
    try {
      const p = await crear(year, month);
      toast(`Mes ${p.name} abierto`, "check");
      await onCreado(p.id);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setGuardando(false); }
  };

  return (
    <Modal open={abierto} onClose={onCerrar} title="Abrir un mes contable" maxWidth="max-w-md">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mes">
          <Select value={String(month)} onChange={(e) => setMonth(Number(e.target.value))}>
            {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Año">
          <Select value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
            {Array.from({ length: 7 }, (_, i) => (ultimo?.year ?? 2026) - 3 + i).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="mt-2 text-[12px] text-text-tertiary">
        Un mes abierto admite asientos con esa fecha. Al cerrarlo se guarda el arrastre y se bloquean.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCerrar} disabled={guardando}>Cancelar</Button>
        <Button onClick={() => void guardar()} disabled={guardando}>{guardando ? "Abriendo…" : "Abrir mes"}</Button>
      </div>
    </Modal>
  );
}
