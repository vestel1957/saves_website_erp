"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { cop } from "@/lib/subscribers";
import { BotonOrden, useTablaOrdenable } from "@/components/ui/tabla-ordenable";
import { ComprobanteCell } from "@/components/treasury/ComprobanteCell";

type Movimiento = {
  id: string;
  date: string;
  type: "INCOME" | "EXPENSE" | "TRANSFER";
  category: string;
  transfer: boolean;
  /** Es una de las patas 'Saldo <fecha>' del arrastre, no un movimiento del día. */
  arrastre: boolean;
  /** Cuenta como efectivo del cajón (y por tanto se barre al cerrar). */
  efectivo: boolean;
  amount: number;
  payer: string;
  subscriberId: string | null;
  method: string | null;
  note: string | null;
  /** Comprobante adjunto del movimiento (soporte del egreso, foto de la consignación…). */
  attach: string | null;
  attachName: string | null;
  invoice: { id: string; tid: number } | null;
};

/**
 * Desglose informativo del efectivo. OJO: el excedente NO se calcula sumando estas
 * líneas — el excedente ES el efectivo del cajón. El arrastre ya viene dentro porque
 * entró como una transacción 'Saldo <fecha>'. Estas líneas sólo explican de qué se
 * compone.
 */
type Desglose = {
  arrastre: number;
  ventas: number;
  egresos: number;
  transferencias: number;
  noEfectivo: number;
};

export type CierreDetalle = {
  id: string | null;
  date: string;
  cashAccountId: number;
  account: { holder: string; accountNumber: string | null } | null;
  yaCerrado: boolean;
  cajero: string | null;
  cerradoEl: string | null;
  proximoDiaHabil: string;
  /** El excedente que se barrió al cerrar (null si aún no se ha cerrado). */
  guardado: number | null;
  efectivo: number;
  excedente: number;
  desglose: Desglose;
  descuadrado: boolean;
  porCategoria: { category: string; type: string; n: number; total: number }[];
  movimientos: Movimiento[];
};

/** Una línea del arqueo. `strong` para el resultado, `muted` para lo informativo. */
function Linea({ label, value, hint, sign, strong, muted }: {
  label: string; value: number; hint?: string;
  sign?: "+" | "−"; strong?: boolean; muted?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${strong ? "border-t border-border-default pt-2.5 mt-1" : ""}`}>
      <span className={`text-[13px] ${muted ? "text-text-tertiary" : "text-text-secondary"} ${strong ? "font-semibold text-text-primary" : ""}`}>
        {label}
        {hint && <span className="ml-1.5 text-[11px] text-text-tertiary">{hint}</span>}
      </span>
      <span className={`tabular-nums ${strong ? "text-base font-semibold" : "text-[13px]"} ${
        sign === "−" ? "text-error-text" : sign === "+" ? "text-success-text" : "text-text-primary"
      }`}>
        {sign && value !== 0 ? (sign === "−" ? "−" : "+") : ""}{cop(Math.abs(value))}
      </span>
    </div>
  );
}

/**
 * El corte grueso y el único que hace falta: qué entró y qué salió. Los traslados a otra
 * caja son plata que sale del cajón, así que van con "Salió" — separarlos en un tercer
 * botón obligaba a pulsar dos cosas para ver todas las salidas del día.
 */
const DIRECCIONES = [
  { k: "in" as const, tipos: ["INCOME"], label: "Entró", icono: "trending-up", ayuda: "Cobranza, arrastre y todo lo que sumó" },
  { k: "out" as const, tipos: ["EXPENSE", "TRANSFER"], label: "Salió", icono: "trending-down", ayuda: "Egresos, compras y traslados a otra caja" },
];

/** Los traslados llegan con la categoría vacía y la fila salía sin concepto. */
const nombreCategoria = (categoria: string, tipo: string) =>
  categoria?.trim() || (tipo === "TRANSFER" ? "Traslado entre cajas" : "Sin concepto");

/**
 * Botón de dirección. No es un pill pequeño: es la cifra del día, y pulsarla filtra.
 * Apagado se lee como un dato más; encendido se tiñe del color de lo que filtra y la
 * cifra pasa al frente, así el estado del filtro se ve sin buscarlo.
 */
function BotonDireccion({ activo, tono, icono, label, ayuda, monto, n, onClick }: {
  activo: boolean;
  tono: "in" | "out";
  icono: string;
  label: string;
  ayuda: string;
  monto: number;
  n: number;
  onClick: () => void;
}) {
  const color = tono === "in" ? "text-success-text" : "text-error-text";
  const encendido = tono === "in"
    ? "border-success-text bg-success-soft"
    : "border-error-text bg-error-soft";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activo}
      title={ayuda}
      className={`group flex flex-1 items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
        activo ? encendido : "border-border-subtle bg-surface hover:border-border-default hover:bg-surface-2"
      }`}
    >
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
        tono === "in" ? "bg-success-soft" : "bg-error-soft"
      } ${color}`}>
        <Icon name={icono} size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className={`text-[12px] font-semibold uppercase tracking-wider ${activo ? color : "text-text-tertiary"}`}>
            {label}
          </span>
          <span className="text-[11px] tabular-nums text-text-tertiary">{n} mov.</span>
        </span>
        <span className={`block text-[17px] font-bold tabular-nums leading-tight ${activo ? color : "text-text-primary"}`}>
          {cop(monto)}
        </span>
      </span>
      <Icon
        name={activo ? "check" : "chevron-right"}
        size={14}
        className={activo ? color : "text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"}
      />
    </button>
  );
}

/**
 * El arqueo de un día: de qué está hecho el efectivo del cajón y qué movimientos lo
 * componen. Es lo que antes vivía dentro del modal "Detalle" del cierre.
 *
 * Se extrajo a su propio componente porque ahora lo pintan dos pantallas: el modal
 * (para quien administra) y la pantalla de Cierre de caja de la cajera, que ya no ve el
 * informe completo sino sólo esto — sus movimientos y su cajón.
 *
 * Sirve igual para un día cerrado (`/treasury/cash-closes/:id`) que para uno abierto
 * (`/treasury/cash-close/preview`): el backend calcula ambos con la misma función.
 *
 * FILTRO: los dos botones de arriba —Entró y Salió— mandan sobre la tabla. Antes ahí había
 * un resumen por categoría que no se podía tocar, y al lado un checkbox suelto que filtraba
 * por otro camino. Dos cortes bastan: el pie dice siempre qué queda seleccionado.
 */
export function CierreArqueo({ d, maxMovimientos = "max-h-80" }: {
  d: CierreDetalle;
  /** Clase de alto máximo de la tabla de movimientos (el modal la acota; la página no). */
  maxMovimientos?: string;
}) {
  const [dirs, setDirs] = useState<Set<"in" | "out">>(new Set());
  const [soloEfectivo, setSoloEfectivo] = useState(false);
  const [busca, setBusca] = useState("");

  const alternarDir = (k: "in" | "out") => {
    const copia = new Set(dirs);
    copia.has(k) ? copia.delete(k) : copia.add(k);
    setDirs(copia);
  };

  const nFiltros = dirs.size + (soloEfectivo ? 1 : 0) + (busca.trim() ? 1 : 0);
  const limpiar = () => { setDirs(new Set()); setSoloEfectivo(false); setBusca(""); };

  /** Cuánto entró y cuánto salió en TODO el día: es el rótulo de cada botón. */
  const totales = useMemo(() => {
    const m = { in: { n: 0, total: 0 }, out: { n: 0, total: 0 } };
    for (const mv of d.movimientos) {
      const b = mv.type === "INCOME" ? m.in : m.out;
      b.n++;
      b.total += Math.abs(Number(mv.amount) || 0);
    }
    return m;
  }, [d.movimientos]);

  const q = busca.trim().toLowerCase();
  const movs = useMemo(
    () => d.movimientos.filter((m) => {
      const dir = m.type === "INCOME" ? "in" : "out";
      return (!dirs.size || dirs.has(dir)) &&
        (!soloEfectivo || m.efectivo) &&
        (!q || m.payer.toLowerCase().includes(q) || String(m.invoice?.tid ?? "").includes(q) ||
          (m.note ?? "").toLowerCase().includes(q));
    }),
    [d.movimientos, dirs, soloEfectivo, q],
  );

  const resumen = useMemo(() => {
    let entro = 0, salio = 0;
    for (const m of movs) {
      const v = Math.abs(Number(m.amount) || 0);
      m.type === "INCOME" ? (entro += v) : (salio += v);
    }
    return { entro, salio };
  }, [movs]);

  // Los movimientos del arqueo son una lista plana: se pueden reordenar sin
  // tocar los totales del cierre, que se calculan aparte.
  const t = useTablaOrdenable(movs, {
    quien: (m) => m.payer,
    concepto: (m) => m.category,
    medio: (m) => m.method,
    factura: (m) => m.invoice?.tid,
    valor: (m) => (m.type === "INCOME" ? 1 : -1) * Math.abs(Number(m.amount) || 0),
  });

  // El saldo acumulado sólo significa algo en el orden en que ocurrieron las cosas: en
  // cuanto se ordena por otra columna, o se filtra, deja de ser un saldo y pasa a ser
  // ruido, así que se vacía.
  //
  // La columna no se quita al filtrar, sólo se vacía: así la tabla no cambia de ancho ni
  // baila cada vez que se pulsa Entró o Salió.
  const conSaldo = !t.orden && nFiltros === 0;
  let saldo = 0;


  return (
    <div className="flex flex-col gap-5">
      {/* El arqueo ya no cuadra con el libro: algo cambió después de cerrar. */}
      {d.descuadrado && (
        <div className="rounded-lg bg-warning-soft px-4 py-3 text-[13px] text-warning-text">
          <strong>Este cierre ya no cuadra con el libro.</strong> Al cerrar se barrieron{" "}
          {cop(d.guardado ?? 0)}, pero con los movimientos vigentes hoy el cajón daría{" "}
          {cop(d.efectivo)}. Algo cambió después de cerrarlo — lo más común: un movimiento
          anulado, o uno cargado con fecha de ese día más tarde.
        </div>
      )}

      {/* ── El arqueo, línea por línea ── */}
      <section>
        <h3 className="mb-1 text-[13px] font-semibold text-text-primary">Cómo se compone</h3>
        <div className="rounded-xl border border-border-subtle bg-surface px-4 py-2">
          <Linea label="Arrastre que entró del cierre anterior" value={d.desglose.arrastre} />
          <Linea label="Recaudo en efectivo del día" value={d.desglose.ventas} sign="+" />
          <Linea label="Egresos en efectivo" value={d.desglose.egresos} sign="−" />
          {d.desglose.transferencias !== 0 && (
            <Linea label="Traslados entre cajas" value={d.desglose.transferencias}
              sign={d.desglose.transferencias < 0 ? "−" : "+"} />
          )}
          {/* El recaudo que no es efectivo ya no se lista: este bloque es el arqueo del
              cajón y esa plata no pasa por él. Mezclarla aquí era invitar a sumarla. */}
          <Linea label={d.yaCerrado ? "Excedente barrido" : "Efectivo en el cajón"}
            value={d.yaCerrado ? (d.guardado ?? 0) : d.efectivo} strong />
        </div>
        <p className="mt-1.5 text-[12px] text-text-tertiary">
          La base es cero: al cerrar se lleva el efectivo entero y se arrastra al{" "}
          <strong className="text-text-secondary">
            {new Date(d.proximoDiaHabil).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" })}
          </strong>{" "}
          (próximo día hábil; el sábado también lo es).
          {d.cajero && <> Cerró <strong className="text-text-secondary">{d.cajero}</strong>.</>}
        </p>
      </section>

      {/* ── Los movimientos, con los pills como filtro ── */}
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-[13px] font-semibold text-text-primary">
            Movimientos del día{" "}
            <span className="font-normal text-text-tertiary">
              {nFiltros ? `(${movs.length} de ${d.movimientos.length})` : `(${d.movimientos.length})`}
            </span>
          </h3>
          {nFiltros > 0 && (
            <button onClick={limpiar} className="text-[12px] font-semibold text-brand hover:underline">
              {nFiltros === 1 ? "Limpiar el filtro" : `Limpiar los ${nFiltros} filtros`}
            </button>
          )}
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface">
          {/* Los dos únicos cortes que se piden a diario: qué entró y qué salió. */}
          <div className="flex flex-col gap-2 p-3 sm:flex-row">
            {DIRECCIONES.map((dir) => (
              <BotonDireccion
                key={dir.k}
                activo={dirs.has(dir.k)}
                tono={dir.k}
                icono={dir.icono}
                label={dir.label}
                ayuda={dir.ayuda}
                monto={totales[dir.k].total}
                n={totales[dir.k].n}
                onClick={() => alternarDir(dir.k)}
              />
            ))}
          </div>

          {/* Búsqueda y el acotado al cajón. No son cortes del día: son ayudas de la tabla. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 pb-3">
            <div className="relative min-w-[11rem] flex-1">
              <Icon name="search" size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por nombre, factura o nota…"
                className="w-full rounded-lg border border-border-subtle bg-surface-2 py-1.5 pl-8 pr-3 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-brand focus:outline-none"
              />
            </div>
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[12px] text-text-secondary">
              <input type="checkbox" checked={soloEfectivo} onChange={(e) => setSoloEfectivo(e.target.checked)} />
              Solo efectivo del cajón
            </label>
          </div>

          <div translate="no" className={`${maxMovimientos} overflow-auto border-t border-border-subtle`}>
            <table className="w-full min-w-[44rem] text-[13px]">
              <thead className="sticky top-0 bg-surface-2">
                <tr className="text-left text-[11px] uppercase tracking-wider text-text-secondary">
                  <th className="px-4 py-3 font-semibold"><BotonOrden t={t} clave="quien">Quién</BotonOrden></th>
                  <th className="px-4 py-3 font-semibold"><BotonOrden t={t} clave="concepto">Concepto</BotonOrden></th>
                  <th className="px-4 py-3 font-semibold"><BotonOrden t={t} clave="medio">Medio</BotonOrden></th>
                  <th className="px-4 py-3 font-semibold"><BotonOrden t={t} clave="factura">Factura</BotonOrden></th>
                  <th className="px-4 py-3 font-semibold">Comprobante</th>
                  <th className="px-4 py-3 text-right font-semibold"><BotonOrden t={t} clave="valor">Valor</BotonOrden></th>
                  <th className={`whitespace-nowrap px-4 py-3 text-right font-semibold ${conSaldo ? "" : "text-text-tertiary/60"}`}>
                    Saldo en caja
                  </th>
                </tr>
              </thead>
              <tbody>
                {!movs.length && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-text-secondary">
                      {nFiltros ? (
                        <span key="con-filtro">
                          <span>Ningún movimiento con estos filtros. </span>
                          <button onClick={limpiar} className="font-semibold text-brand hover:underline">Quítalos</button>
                          <span> para verlos todos.</span>
                        </span>
                      ) : (
                        <span key="sin-filtro">Sin movimientos.</span>
                      )}
                    </td>
                  </tr>
                )}
                {t.filas.map((m) => {
                  if (conSaldo && m.efectivo) saldo += (m.type === "INCOME" ? 1 : -1) * Math.abs(Number(m.amount) || 0);
                  return (
                    <tr key={m.id} className="border-t border-border-subtle hover:bg-surface-2">
                      <td className="px-4 py-3">
                        {m.subscriberId
                          ? <a href={`/clientes/${m.subscriberId}`} className="text-brand hover:underline">{m.payer}</a>
                          : <span className="text-text-secondary">{m.payer}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-text-secondary">{nombreCategoria(m.category, m.type)}</span>
                        {m.transfer && <Badge tone="info" label="traslado" />}
                        {m.note ? <span className="ml-1.5 text-text-tertiary">{m.note}</span> : null}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-text-tertiary">{m.method ?? "—"}</span>
                        {!m.efectivo && (
                          <span className="ml-1.5 rounded px-1 py-px text-[10px] font-semibold text-text-tertiary ring-1 ring-border-subtle">
                            no efectivo
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {m.invoice
                          ? <a href={`/facturacion/${m.invoice.id}`} className="text-brand hover:underline">#{m.invoice.tid}</a>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      {/* El soporte del gasto, aquí mismo: revisar el cierre era salirse a
                          /tesoreria/egresos a buscar la fila para poder abrirlo.

                          Subir sólo se ofrece en las SALIDAS, que es lo que se revisa en un
                          cierre: en un día de 190 cobros, una columna entera de "Adjuntar"
                          tapaba los pocos egresos que sí llevan soporte. Un ingreso con
                          comprobante se ve igual —y se adjunta desde /tesoreria/ingresos—.
                          El arrastre no es un movimiento real, así que no admite ninguno. */}
                      <td className="px-4 py-3">
                        {m.arrastre
                          ? <span className="text-text-tertiary">—</span>
                          : <ComprobanteCell id={m.id} attach={m.attach} attachName={m.attachName}
                              soloLectura={m.type === "INCOME"} />}
                      </td>
                      {/* `whitespace-nowrap`: sin esto, en un concepto largo la columna se
                          estrecha y el signo se va a un renglón aparte del número. */}
                      <td className={`whitespace-nowrap px-4 py-3 text-right tabular-nums ${m.type === "INCOME" ? "text-success-text" : "text-error-text"}`}>
                        {m.type === "INCOME" ? "+" : "−"}{cop(m.amount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-text-tertiary">
                        {conSaldo && m.efectivo ? cop(saldo) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pie: qué suma lo que se está viendo AHORA, con el filtro puesto. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border-subtle bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">
            <span className="tabular-nums">
              {nFiltros
                ? `${movs.length} de ${d.movimientos.length} movimientos`
                : `${movs.length} movimientos`}
            </span>
            <span>Entró <strong className="tabular-nums text-success-text">{cop(resumen.entro)}</strong></span>
            <span>Salió <strong className="tabular-nums text-error-text">{cop(resumen.salio)}</strong></span>
            <span>Neto <strong className="tabular-nums text-text-primary">{cop(resumen.entro - resumen.salio)}</strong></span>
          </div>
        </div>
      </section>
    </div>
  );
}
