"use client";

import { cop } from "@/lib/subscribers";
import type { InformeCierreData } from "@/lib/treasury";

/**
 * El informe del cierre de caja, tal y como lo pinta el legacy en pantalla
 * (`views/reports/statement_list.php`), en su mismo orden:
 *
 *   cabecera → Cobranza → Banco → Servicios → cargos por meses → Forma de pago →
 *   Anulaciones → meses INTERNET → meses TV → tipo de servicio → Egresos
 *
 * Los números son los del legacy con sus rarezas incluidas (ver `cierre-informe.ts`):
 * el IVA por ítem "tele", "Excento" contando ítems mientras "Base" cuenta transacciones,
 * el combo repartido 40/60 contado en ambos lados, Materiales y Otros en duro a 0.
 * Se replican a propósito: son las cifras que el personal lee todos los días.
 */

const fmtHora = (d?: string | null) =>
  d ? new Date(d).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit", hour12: true }) : "—";

type Fila = { label: string; cant?: number | string; monto: number; sub?: boolean };

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

export function InformeCierre({ d }: { d: InformeCierreData }) {
  const a = d.arqueo;
  const m = d.meses;
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

  return (
    <div className="flex flex-col gap-5">
      {/* ── Cabecera: los mismos campos que el legacy ── */}
      <section className="rounded-xl border border-border-subtle bg-surface px-4 py-3">
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

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
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
