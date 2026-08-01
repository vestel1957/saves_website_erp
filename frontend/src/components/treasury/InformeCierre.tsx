"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { cop } from "@/lib/subscribers";
import type { InformeCierreData } from "@/lib/treasury";

/**
 * El informe del cierre de caja. Los NÚMEROS son los del legacy
 * (`views/reports/statement_list.php`), con sus rarezas incluidas — ver
 * `cierre-informe.ts`: el IVA por ítem "tele", "Excento" contando ítems mientras "Base"
 * cuenta transacciones, el combo repartido 40/60 contado en ambos lados, Materiales y
 * Otros en duro a 0. Se replican a propósito: son las cifras con las que se concilia
 * contra el sistema viejo.
 *
 * Lo que cambió es CÓMO se leen. Antes eran diez tablas simultáneas, todas con la misma
 * pinta y el mismo peso visual, en una rejilla de dos columnas: para saber qué pasó el
 * día había que leerlas todas, y el número que de verdad se busca —cuánto hay en el
 * cajón— iba en un renglón gris de 12 px por encima de ellas. Ahora:
 *
 *   1. la cinta de cuadre y los indicadores responden eso primero;
 *   2. los diez bloques pasan a UNA tabla con pestañas, con barra proporcional y % para
 *      ver qué pesa sin leer cifra por cifra;
 *   3. "Ver como el legacy" devuelve la rejilla clásica entera, para auditar.
 *
 * Las rarezas heredadas se marcan con un icono de aviso en la fila, en vez de quedar sin
 * explicación al lado de un número que no cuadra.
 */

const fmtHora = (d?: string | null) =>
  d ? new Date(d).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit", hour12: true }) : "—";

type Plan = { clave: string; megas: number; cantidad: number; monto: number };

/**
 * El legacy saca los megas del nombre del producto a fuerza de `str_replace`, así que
 * "10 Megas", "10 Megas Solo Internet" y "10 Megas Dedicadas" acaban todos rotulados
 * "Internet 10MG" y en pantalla salían tres filas idénticas con cifras distintas —
 * imposible saber cuál era cuál. Cuando los megas se repiten se añade la clave que los
 * separa; cuando no, el rótulo se queda como estaba.
 */
function etiquetaPlan(p: Plan, todos: Plan[]): string {
  const base = `Internet ${p.megas}MG`;
  const repetido = todos.filter((x) => x.megas === p.megas).length > 1;
  return repetido ? `${base} · ${p.clave}` : base;
}

type Bucket = { cantidad: number; monto: number };
type Fila = { label: string; cant?: number | string; monto: number; sub?: boolean; nota?: string };

/* ─────────────────────────── Piezas ─────────────────────────── */

/** Una tabla DESCRIPCION / CANT / MONTO, que es la forma de todos los bloques del legacy. */
function Tabla({ titulo, filas, total, nota }: {
  titulo: string;
  filas: Fila[];
  total?: { label: string; cant?: number | string; monto: number };
  nota?: string;
}) {
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-[13px] font-semibold text-text-primary">{titulo}</h3>
      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-2 text-[10px] uppercase text-text-tertiary">
              <th className="px-3 py-1.5 text-left font-semibold">Descripción</th>
              <th className="px-3 py-1.5 text-right font-semibold">Cant</th>
              <th className="px-3 py-1.5 text-right font-semibold">Monto</th>
            </tr>
          </thead>
          <tbody>
            {filas.length === 0 && (
              <tr><td colSpan={3} className="px-3 py-3 text-center text-text-tertiary">Sin datos</td></tr>
            )}
            {filas.map((f, i) => (
              <tr key={`${f.label}-${i}`} className="border-b border-border-subtle last:border-0">
                <td className={`px-3 py-1.5 ${f.sub ? "font-medium text-text-primary" : "text-text-secondary"}`}>{f.label}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-text-tertiary">{f.cant ?? ""}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-text-primary">{cop(f.monto)}</td>
              </tr>
            ))}
          </tbody>
          {total && (
            <tfoot>
              <tr className="border-t-2 border-border-default bg-surface-2 font-bold text-text-primary">
                <td className="px-3 py-2 text-[11px] uppercase">{total.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{total.cant ?? ""}</td>
                <td className="px-3 py-2 text-right tabular-nums">{cop(total.monto)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {nota && <p className="mt-1 text-[11px] text-text-tertiary">{nota}</p>}
    </section>
  );
}

/** Rampa de un solo tono: aquí no hay identidades que distinguir, sólo magnitudes. */
const RAMPA = [1, 0.82, 0.66, 0.52, 0.4, 0.3, 0.22];

/**
 * La composición del bloque en una sola barra apilada, con su leyenda.
 *
 * Responde de un vistazo la pregunta que uno le hace a un desglose —"¿qué pesa aquí?"—
 * antes de bajar a la tabla. Se muestran los seis mayores y el resto se agrupa: con
 * quince tajadas la barra deja de decir nada.
 */
function Composicion({ filas, total }: { filas: Fila[]; total: number }) {
  const positivas = filas.filter((f) => f.monto > 0).sort((a, b) => b.monto - a.monto);
  if (positivas.length < 2 || total <= 0) return null;

  const cabeza = positivas.slice(0, 6);
  const cola = positivas.slice(6);
  const segmentos = cola.length
    ? [...cabeza, { label: `Otros ${cola.length}`, monto: cola.reduce((s, f) => s + f.monto, 0) }]
    : cabeza;

  return (
    <div className="border-b border-border-subtle px-4 py-3.5">
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2">
        {segmentos.map((f, i) => (
          <span
            key={f.label}
            title={`${f.label} · ${cop(f.monto)} · ${((f.monto / total) * 100).toFixed(1)}%`}
            className="bg-brand first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(f.monto / total) * 100}%`, opacity: RAMPA[i] ?? 0.18 }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {segmentos.map((f, i) => (
          <span key={f.label} className="inline-flex items-center gap-1.5 text-[11.5px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-brand" style={{ opacity: RAMPA[i] ?? 0.18 }} />
            <span className="text-text-secondary">{f.label}</span>
            <span className="font-semibold tabular-nums text-text-primary">
              {((f.monto / total) * 100).toFixed(1)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * El desglose de un bloque: barra de composición arriba y la tabla debajo.
 *
 * La tabla no lleva una barrita al lado del texto sino que la fila ENTERA se tiñe en
 * proporción a lo que pesa. Con doce planes de internet, comparar doce cifras a ojo cuesta;
 * con la fila teñida el orden de magnitud se ve sin leer un solo dígito, y el número sigue
 * ahí, grande, para quien tenga que copiarlo.
 *
 * Las filas `sub` son los totales que el legacy intercala dentro del bloque (Total Ventas,
 * Total Reconexiones…): no son un concepto más, así que no se tiñen ni entran en el total.
 */
function DesgloseBloque({ filas, totalLabel }: { filas: Fila[]; totalLabel: string }) {
  const principales = filas.filter((f) => !f.sub);
  const total = principales.reduce((s, f) => s + f.monto, 0);
  const totalCant = principales.reduce((s, f) => s + (typeof f.cant === "number" ? f.cant : 0), 0);
  const mayor = principales.reduce<Fila | null>((a, f) => (!a || f.monto > a.monto ? f : a), null);

  return (
    <>
      <Composicion filas={principales} total={total} />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-2 text-[11px] uppercase tracking-wider text-text-secondary">
              <th className="px-4 py-3 text-left font-semibold">Concepto</th>
              <th className="w-24 px-4 py-3 text-right font-semibold">Cant</th>
              <th className="w-40 px-4 py-3 text-right font-semibold">Monto</th>
              <th className="w-24 px-4 py-3 text-right font-semibold">Peso</th>
            </tr>
          </thead>
          <tbody>
            {filas.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-12 text-center text-[13px] text-text-tertiary">Sin datos ese día.</td></tr>
            )}
            {filas.map((f, i) => {
              // El tinte se mide contra el TOTAL, no contra la fila mayor: así lo que se ve
              // pintado y lo que dice la columna "Peso" son el mismo número. Escalarlo al
              // mayor haría barras más largas y más fáciles de comparar entre sí, pero una
              // fila teñida al 32% con un "11,1%" escrito al lado invita a desconfiar de las
              // dos cosas, y esto es un documento de caja.
              const parte = total ? f.monto / total : 0;
              const tinte = Math.min(100, Math.max(0, parte * 100));
              const esMayor = !f.sub && f === mayor && principales.length > 1 && f.monto > 0;
              return (
                <tr
                  key={`${f.label}-${i}`}
                  className={`border-b border-border-subtle last:border-0 ${f.sub ? "bg-surface-2/60" : ""}`}
                  // La fila teñida: `brand-soft` hasta donde llega su peso y nada después.
                  style={f.sub ? undefined : {
                    background: `linear-gradient(to right, var(--color-brand-soft) ${tinte}%, transparent ${tinte}%)`,
                  }}
                >
                  <td className="px-4 py-3.5">
                    <span className="flex items-center gap-2">
                      {esMayor && <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-brand" aria-hidden />}
                      <span className={f.sub
                        ? "text-[12.5px] font-semibold uppercase tracking-wide text-text-tertiary"
                        : "text-[13.5px] font-medium text-text-primary"}>
                        {f.label}
                      </span>
                      {f.nota && (
                        <span title={f.nota} className="inline-flex shrink-0 cursor-help text-text-tertiary">
                          <Icon name="info" size={12} />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-right text-[12.5px] tabular-nums text-text-tertiary">
                    {f.cant === "" || f.cant == null ? "—" : `× ${f.cant}`}
                  </td>
                  <td className={`whitespace-nowrap px-4 py-3.5 text-right tabular-nums ${
                    f.sub ? "text-[13px] font-semibold text-text-secondary" : "text-[15px] font-bold text-text-primary"
                  }`}>
                    {cop(f.monto)}
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    {f.sub || !total ? (
                      <span className="text-[12px] text-text-tertiary">—</span>
                    ) : (
                      <span className="inline-block min-w-[3rem] rounded-md bg-surface-2 px-1.5 py-0.5 text-center text-[11.5px] font-semibold tabular-nums text-text-secondary">
                        {(parte * 100).toFixed(1)}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-brand bg-brand-soft">
              <td className="px-4 py-4 text-[11px] font-bold uppercase tracking-wider text-brand">{totalLabel}</td>
              <td className="whitespace-nowrap px-4 py-4 text-right text-[12.5px] font-semibold tabular-nums text-brand">
                {totalCant ? `× ${totalCant}` : ""}
              </td>
              <td className="whitespace-nowrap px-4 py-4 text-right text-[17px] font-bold tabular-nums text-brand">{cop(total)}</td>
              <td className="px-4 py-4 text-right text-[12.5px] font-semibold tabular-nums text-brand">{total ? "100%" : "—"}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

/** Un paso de la cinta de cuadre. El resultado va teñido de marca para que salte. */
function Paso({ op, k, v, tono }: { op?: string; k: string; v: number; tono?: "pos" | "neg" | "res" }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 px-4 py-3 ${tono === "res" ? "bg-brand-soft" : "bg-surface"}`}>
      <span className="text-[11px] font-bold text-text-tertiary">{op || " "}</span>
      <span className={`text-[12px] leading-snug ${tono === "res" ? "font-semibold text-brand" : "text-text-secondary"}`}>{k}</span>
      <span className={`text-lg font-bold tabular-nums leading-tight ${
        tono === "res" ? "text-brand" : tono === "pos" ? "text-success-text" : tono === "neg" ? "text-error-text" : "text-text-primary"
      }`}>
        {cop(v)}
      </span>
    </div>
  );
}

/** Los cuatro números del día. La barrita los pone en escala contra el cobrado. */
const TONO_IND = {
  ok: { texto: "text-success-text", barra: "bg-success-text" },
  brand: { texto: "text-brand", barra: "bg-brand" },
  neutro: { texto: "text-text-primary", barra: "bg-text-tertiary" },
  mal: { texto: "text-error-text", barra: "bg-error-text" },
} as const;

function Indicador({ k, v, sub, tono, pct }: {
  k: string; v: number; sub: string; tono: keyof typeof TONO_IND; pct: number;
}) {
  const c = TONO_IND[tono];
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border-subtle bg-surface px-4 py-3">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{k}</span>
      <span className={`text-xl font-bold tabular-nums leading-none ${c.texto}`}>{cop(v)}</span>
      <span className="block h-[3px] overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full ${c.barra}`}
          style={{ width: `${Math.min(100, Math.max(0, pct * 100)).toFixed(1)}%` }} />
      </span>
      <span className="text-[11.5px] text-text-tertiary">{sub}</span>
    </div>
  );
}

function Dato({ k, v, fuerte }: { k: string; v: string; fuerte?: boolean }) {
  return (
    <p className="flex items-baseline gap-1.5">
      <span className="text-text-tertiary">{k}:</span>
      <span className={fuerte ? "font-bold text-text-primary" : "font-medium text-text-secondary"}>{v}</span>
    </p>
  );
}

/* ─────────────────────────── El informe ─────────────────────────── */

export function InformeCierre({ d }: { d: InformeCierreData }) {
  const [pestana, setPestana] = useState("Forma de pago");
  const [legacy, setLegacy] = useState(false);

  const a = d.arqueo;
  const m = d.meses;
  const g = a.desglose;
  const mesNombre = (delta: number) => {
    const base = new Date(d.fecha);
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + delta, 1))
      .toLocaleDateString("es-CO", { month: "long", year: "numeric" });
  };

  const totalBanco = {
    cant: d.porBanco.reduce((s, b) => s + b.cantidad, 0),
    monto: d.porBanco.reduce((s, b) => s + b.monto, 0),
  };
  const fp = d.formaPago;
  const totalFormaPago = {
    cant: fp.saldoAnterior.cantidad + fp.efectivo.cantidad + fp.transferencia.cantidad + fp.wompi.cantidad,
    monto: fp.saldoAnterior.monto + fp.efectivo.monto + fp.transferencia.monto + fp.wompi.monto,
  };
  const mes = (b: Bucket & { Internet: Bucket; Television: Bucket }) => b;

  /** Contra qué se escalan las barritas de los indicadores. */
  const cobrado = d.cobranza.total.monto || 1;

  /* Los bloques del legacy, reagrupados en pestañas. Ninguno desaparece. */
  const bloques: Record<string, { filas: Fila[]; total: string; nota: string }> = {
    "Forma de pago": {
      total: "Total forma de pago",
      nota: "Cómo entró la plata. Es el bloque que se concilia contra el legacy cifra por cifra.",
      filas: [
        { label: "Saldo anterior", cant: fp.saldoAnterior.cantidad, monto: fp.saldoAnterior.monto },
        { label: "Efectivo", cant: fp.efectivo.cantidad, monto: fp.efectivo.monto },
        { label: "Transferencia", cant: fp.transferencia.cantidad, monto: fp.transferencia.monto },
        { label: "WOMPI", cant: fp.wompi.cantidad, monto: fp.wompi.monto },
      ],
    },
    "Servicios": {
      total: "Total servicios",
      nota: "Reparto por producto de la factura, prorrateado como en el legacy. Varios planes distintos pueden dar los mismos megas: se distinguen por su clave.",
      filas: [
        ...d.servicios.planes.map((p) => ({ label: etiquetaPlan(p, d.servicios.planes), cant: p.cantidad, monto: p.monto })),
        ...(d.servicios.television.cantidad
          ? [{ label: "Television", cant: d.servicios.television.cantidad, monto: d.servicios.television.monto }]
          : []),
        ...d.servicios.afiliaciones.map((x) => ({ label: x.producto, cant: x.cantidad, monto: x.monto })),
        { label: "Total Reconexiones", cant: d.servicios.reconexiones.cantidad, monto: d.servicios.reconexiones.monto, sub: true },
        { label: "Total Materiales", cant: d.servicios.materiales.cantidad, monto: d.servicios.materiales.monto, sub: true,
          nota: "El legacy lo imprime fijo en 0: no es que no haya, es que nunca lo calculó." },
        { label: "Total Otros", cant: d.servicios.otros.cantidad, monto: d.servicios.otros.monto, sub: true,
          nota: "El legacy lo imprime fijo en 0: no es que no haya, es que nunca lo calculó." },
      ],
    },
    "Tipo de servicio": {
      total: "Total tipo de servicio",
      nota: "Corte grueso Internet / TV. Aquí reconexiones, afiliaciones y notas crédito caen en Internet (así lo clasifica el legacy).",
      filas: [
        { label: "Internet", cant: d.tipoServicio.Internet.cantidad, monto: d.tipoServicio.Internet.monto },
        { label: "Television", cant: d.tipoServicio.Television.cantidad, monto: d.tipoServicio.Television.monto },
      ],
    },
    "Meses cobrados": {
      total: "Total cobranza por meses",
      nota: "Por fecha de la FACTURA, no del pago. El monto es el recaudo crudo, por eso no cuadra con Internet + TV (igual que el legacy).",
      filas: [
        { label: mesNombre(0), cant: m.actual.cantidad, monto: m.actual.monto },
        { label: mesNombre(-1), cant: m.anterior.cantidad, monto: m.anterior.monto },
        { label: "Meses anteriores", cant: m.anteriores.cantidad, monto: m.anteriores.monto },
        { label: `Internet · ${mesNombre(0)}`, cant: mes(m.actual).Internet.cantidad, monto: mes(m.actual).Internet.monto, sub: true },
        { label: `Internet · ${mesNombre(-1)}`, cant: mes(m.anterior).Internet.cantidad, monto: mes(m.anterior).Internet.monto, sub: true },
        { label: "Internet · meses anteriores", cant: mes(m.anteriores).Internet.cantidad, monto: mes(m.anteriores).Internet.monto, sub: true },
        { label: `TV · ${mesNombre(0)}`, cant: mes(m.actual).Television.cantidad, monto: mes(m.actual).Television.monto, sub: true },
        { label: `TV · ${mesNombre(-1)}`, cant: mes(m.anterior).Television.cantidad, monto: mes(m.anterior).Television.monto, sub: true },
        { label: "TV · meses anteriores", cant: mes(m.anteriores).Television.cantidad, monto: mes(m.anteriores).Television.monto, sub: true },
      ],
    },
    "Bancos": {
      total: "Total banco",
      nota: "Movimientos de banco que caen en esta caja porque el referente de la factura dice esta sede.",
      filas: d.porBanco.map((b) => ({ label: b.nombre, cant: b.cantidad, monto: b.monto })),
    },
    "Cobranza / IVA": {
      total: "Total cobranza",
      nota: "Bloque heredado: los tres renglones suman unidades distintas y aun así el legacy los totaliza junto. Se conserva tal cual.",
      filas: [
        { label: "Excento", cant: d.cobranza.excento.cantidad, monto: d.cobranza.excento.monto,
          nota: "Cuenta ÍTEMS de factura, no transacciones." },
        { label: "Base", cant: d.cobranza.base.cantidad, monto: d.cobranza.base.monto,
          nota: "Cuenta TRANSACCIONES con IVA, no ítems." },
        { label: "IVA", cant: "", monto: d.cobranza.iva.monto },
      ],
    },
    "Egresos": {
      total: "Total egresos",
      nota: "Salidas de la caja. Los traslados a otra caja se listan aparte del gasto.",
      filas: [
        { label: "Pago Orden de Compra", cant: d.egresos.ordenes.cantidad, monto: d.egresos.ordenes.monto },
        { label: "Transacciones", cant: d.egresos.transacciones.cantidad, monto: d.egresos.transacciones.monto },
        { label: "Transferencias", cant: d.egresos.traslados.cantidad, monto: d.egresos.traslados.monto },
      ],
    },
    "Anulaciones": {
      total: "Cobrado − anulado de otras fechas",
      nota: "Lo que se cayó del día. La cobranza efectiva incluye lo anulado; el neto es lo que de verdad quedó.",
      filas: [
        { label: "Anulado de este cierre", cant: d.anulaciones.anuladoDeCierre.cantidad, monto: d.anulaciones.anuladoDeCierre.monto },
        { label: "Anulado de otros cierres", cant: d.anulaciones.anuladoDeOtrosCierres.cantidad, monto: d.anulaciones.anuladoDeOtrosCierres.monto },
        { label: "Cobranza efectiva", cant: "", monto: d.anulaciones.cobranzaEfectiva.monto, sub: true },
      ],
    },
  };
  const pestanas = Object.keys(bloques);
  const bloque = bloques[pestana] ?? bloques[pestanas[0]];

  return (
    <div className="flex flex-col gap-5">
      {/* ── Cabecera: los mismos campos que el legacy ── */}
      <section className="shrink-0 rounded-xl border border-border-subtle bg-surface px-4 py-3">
        <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Cierre de Caja</h3>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[12px] sm:grid-cols-3">
          <Dato k="Caja" v={d.caja.holder + (d.caja.accountNumber ? ` · ${d.caja.accountNumber}` : "")} />
          <Dato k="Fecha" v={new Date(d.fecha).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })} />
          <Dato k="Cajero" v={a.cajero ?? "—"} />
          <Dato k="Hora apertura" v={fmtHora(a.horaApertura)} />
          <Dato k="Hora cierre" v={fmtHora(a.horaCierre)} />
          <Dato k="Efectivo Caja" v={cop(a.excedente)} fuerte />
        </div>
        {a.migrado && (
          <p className="mt-2 text-[11px] text-text-tertiary">
            Cierre migrado del legacy: allá las horas eran las de la sesión de quien miraba la
            pantalla, no las de la caja, así que no se conservaron.
          </p>
        )}
      </section>

      {/* ── La cinta de cuadre: la respuesta antes que cualquier tabla ── */}
      {g && (
        <section className="shrink-0">
          <h3 className="mb-1 text-[13px] font-semibold text-text-primary">Cómo se compone el cajón</h3>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle sm:grid-cols-3 lg:grid-cols-5">
            <Paso k="Arrastre del cierre anterior" v={g.arrastre} />
            <Paso op="+" k="Recaudo en efectivo del día" v={g.ventas} tono="pos" />
            <Paso op="−" k="Egresos en efectivo" v={g.egresos} tono="neg" />
            <Paso op={g.transferencias < 0 ? "−" : "+"} k="Traslados entre cajas" v={Math.abs(g.transferencias)}
              tono={g.transferencias < 0 ? "neg" : "pos"} />
            <Paso op="=" k={a.yaCerrado ? "Excedente barrido" : "Efectivo en el cajón"} v={a.excedente} tono="res" />
          </div>
        </section>
      )}

      {/* ── Los indicadores del día ── */}
      {/* Tres, no cuatro: el recaudo que no es efectivo se quitó. Esta pantalla es el
          arqueo del cajón y esa plata nunca pasa por él. */}
      <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <Indicador k="Cobrado del día" v={d.cobranza.total.monto} tono="ok" pct={1}
          sub={`${d.cobranza.total.cantidad} cargos cobrados`} />
        <Indicador k="Efectivo en el cajón" v={a.excedente} tono="brand" pct={a.excedente / cobrado}
          sub={a.yaCerrado ? "ya se barrió al cerrar" : "se barre al cerrar"} />
        <Indicador k="Egresos del día" v={d.egresos.total.monto} tono="mal"
          pct={d.egresos.total.monto / cobrado} sub={`${d.egresos.total.cantidad} salidas de caja`} />
      </div>

      {/* ── El desglose: una tabla a la vez, no diez a la vez ── */}
      <section className="shrink-0 overflow-hidden rounded-xl border border-border-subtle bg-surface">
        <div className="flex items-center gap-3 border-b border-border-subtle px-3">
          <div className="flex flex-1 gap-1 overflow-x-auto py-1.5" role="tablist">
            {pestanas.map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={p === pestana}
                onClick={() => setPestana(p)}
                className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                  p === pestana ? "bg-brand-soft text-brand" : "text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            onClick={() => setLegacy((v) => !v)}
            title="Las mismas cifras en las tablas del sistema viejo, todas a la vez"
            className="hidden shrink-0 items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2 sm:inline-flex"
          >
            <Icon name="layers" size={13} /> {legacy ? "Vista nueva" : "Ver como el legacy"}
          </button>
        </div>

        {!legacy && (
          <>
            <DesgloseBloque filas={bloque.filas} totalLabel={bloque.total} />
            <p className="border-t border-border-subtle bg-surface-2 px-4 py-2 text-[11.5px] text-text-tertiary">
              {bloque.nota}
            </p>
          </>
        )}
      </section>

      {/* ── La rejilla clásica, tal cual la pinta el legacy, para auditar ── */}
      {legacy && (
        <div className="grid shrink-0 grid-cols-1 gap-5 lg:grid-cols-2">
          <Tabla
            titulo="Resumen Cobranza"
            filas={[
              { label: "Excento", cant: d.cobranza.excento.cantidad, monto: d.cobranza.excento.monto },
              { label: "Base", cant: d.cobranza.base.cantidad, monto: d.cobranza.base.monto },
              { label: "iva", monto: d.cobranza.iva.monto },
            ]}
            total={{ label: "Total cobranza", cant: d.cobranza.total.cantidad, monto: d.cobranza.total.monto }}
          />

          <Tabla
            titulo="Resumen por Banco"
            filas={d.porBanco.map((b) => ({ label: b.nombre, cant: b.cantidad, monto: b.monto }))}
            total={{ label: "Total cobranza", cant: totalBanco.cant, monto: totalBanco.monto }}
          />

          <Tabla
            titulo="Resumen por Forma de pago"
            filas={[
              { label: "Saldo Anterior", cant: fp.saldoAnterior.cantidad, monto: fp.saldoAnterior.monto },
              { label: "Efectivo", cant: fp.efectivo.cantidad, monto: fp.efectivo.monto },
              { label: "Transferencia", cant: fp.transferencia.cantidad, monto: fp.transferencia.monto },
              { label: "WOMPI", cant: fp.wompi.cantidad, monto: fp.wompi.monto },
            ]}
            total={{ label: "Total forma pago", cant: totalFormaPago.cant, monto: totalFormaPago.monto }}
          />

          <Tabla
            titulo="Resumen por tipo de servicio"
            filas={[
              { label: "Internet", cant: d.tipoServicio.Internet.cantidad, monto: d.tipoServicio.Internet.monto },
              { label: "Television", cant: d.tipoServicio.Television.cantidad, monto: d.tipoServicio.Television.monto },
            ]}
            total={{
              label: "Total tipo de servicios",
              cant: d.tipoServicio.Internet.cantidad + d.tipoServicio.Television.cantidad,
              monto: d.tipoServicio.Internet.monto + d.tipoServicio.Television.monto,
            }}
          />

          <Tabla
            titulo="Resumen por Servicios"
            filas={[
              ...d.servicios.planes.map((p) => ({ label: `Internet ${p.megas}MG`, cant: p.cantidad, monto: p.monto })),
              ...(d.servicios.television.cantidad
                ? [{ label: "Television", cant: d.servicios.television.cantidad, monto: d.servicios.television.monto }]
                : []),
              ...d.servicios.afiliaciones.map((x) => ({ label: x.producto, cant: x.cantidad, monto: x.monto })),
              { label: "Total Ventas", cant: d.servicios.ventas.cantidad, monto: d.servicios.ventas.monto, sub: true },
              { label: "Total Reconexiones", cant: d.servicios.reconexiones.cantidad, monto: d.servicios.reconexiones.monto, sub: true },
              { label: "Total Materiales", cant: d.servicios.materiales.cantidad, monto: d.servicios.materiales.monto, sub: true },
              { label: "Total Otros", cant: d.servicios.otros.cantidad, monto: d.servicios.otros.monto, sub: true },
            ]}
            total={{ label: "Total", cant: d.servicios.total.cantidad, monto: d.servicios.total.monto }}
            nota="Materiales y Otros van fijos en 0: el legacy los imprime así."
          />

          <Tabla
            titulo="Resumen Egresos"
            filas={[
              { label: "Pago Orden de Compra", cant: d.egresos.ordenes.cantidad, monto: d.egresos.ordenes.monto },
              ...(d.egresos.traslados.cantidad ? [{ label: "Transferencias", cant: d.egresos.traslados.cantidad, monto: d.egresos.traslados.monto }] : []),
              ...(d.egresos.transacciones.cantidad ? [{ label: "Transacciones", cant: d.egresos.transacciones.cantidad, monto: d.egresos.transacciones.monto }] : []),
            ]}
            total={{ label: "Total egresos", cant: d.egresos.total.cantidad, monto: d.egresos.total.monto }}
          />

          <Tabla
            titulo="Resumen de cargos cobrados por meses"
            filas={[
              { label: mesNombre(0), cant: m.actual.cantidad, monto: m.actual.monto },
              { label: mesNombre(-1), cant: m.anterior.cantidad, monto: m.anterior.monto },
              { label: "Meses anteriores", cant: m.anteriores.cantidad, monto: m.anteriores.monto },
            ]}
            total={{
              label: "Total cobranza por meses",
              cant: m.actual.cantidad + m.anterior.cantidad + m.anteriores.cantidad,
              monto: m.actual.monto + m.anterior.monto + m.anteriores.monto,
            }}
            nota="El monto es el recaudo crudo; por eso no cuadra con Internet + TV de abajo (igual que el legacy)."
          />

          <Tabla
            titulo="Resumen Anulaciones"
            filas={[
              { label: "Anulado de cierre", cant: d.anulaciones.anuladoDeCierre.cantidad, monto: d.anulaciones.anuladoDeCierre.monto },
              { label: "Anulado de otros cierres", cant: d.anulaciones.anuladoDeOtrosCierres.cantidad, monto: d.anulaciones.anuladoDeOtrosCierres.monto },
              { label: "Cobranza efectiva", monto: d.anulaciones.cobranzaEfectiva.monto },
            ]}
            total={{ label: "Cobrado − anulado de otras fechas", monto: d.anulaciones.cobradoNeto }}
          />

          <Tabla
            titulo="Cargos cobrados por meses · INTERNET"
            filas={[
              { label: mesNombre(0), cant: m.actual.Internet.cantidad, monto: m.actual.Internet.monto },
              { label: mesNombre(-1), cant: m.anterior.Internet.cantidad, monto: m.anterior.Internet.monto },
              { label: "Meses anteriores", cant: m.anteriores.Internet.cantidad, monto: m.anteriores.Internet.monto },
            ]}
            total={{
              label: "Total internet",
              cant: m.actual.Internet.cantidad + m.anterior.Internet.cantidad + m.anteriores.Internet.cantidad,
              monto: m.actual.Internet.monto + m.anterior.Internet.monto + m.anteriores.Internet.monto,
            }}
          />

          <Tabla
            titulo="Cargos cobrados por meses · TV"
            filas={[
              { label: mesNombre(0), cant: m.actual.Television.cantidad, monto: m.actual.Television.monto },
              { label: mesNombre(-1), cant: m.anterior.Television.cantidad, monto: m.anterior.Television.monto },
              { label: "Meses anteriores", cant: m.anteriores.Television.cantidad, monto: m.anteriores.Television.monto },
            ]}
            total={{
              label: "Total TV",
              cant: m.actual.Television.cantidad + m.anterior.Television.cantidad + m.anteriores.Television.cantidad,
              monto: m.actual.Television.monto + m.anterior.Television.monto + m.anteriores.Television.monto,
            }}
          />
        </div>
      )}
    </div>
  );
}
