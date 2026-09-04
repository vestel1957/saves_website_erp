"use client";

import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { fmtDateTime } from "@/lib/format";

export type Movimiento = {
  id: string;
  fecha: string;
  tipo: "EMITIDA" | "EDICION" | "ANULACION" | "SERVICIO" | "NOTA_CREDITO" | "NOTA_DEBITO";
  titulo: string;
  por: string | null;
  motivo: string | null;
  cambios: string[];
  monto?: number | null;
};

const PINTA: Record<Movimiento["tipo"], { icon: string; tone: "default" | "warning" | "error" | "info" | "success" }> = {
  EMITIDA: { icon: "receipt", tone: "success" },
  EDICION: { icon: "pencil", tone: "warning" },
  ANULACION: { icon: "ban", tone: "error" },
  SERVICIO: { icon: "activity", tone: "info" },
  NOTA_CREDITO: { icon: "file-text", tone: "info" },
  NOTA_DEBITO: { icon: "file-text", tone: "info" },
};

/**
 * Historial de la factura: qué se le hizo, quién y POR QUÉ.
 *
 * El motivo del cambio se pide al editar y al anular desde hace tiempo, pero se
 * guardaba sólo dentro de la auditoría: en pantalla quedaba el rótulo "Editada"
 * con la fecha y nada más. Quien abría la factura después —contabilidad, la
 * cajera, el cliente reclamando— no tenía cómo saber qué renglón se tocó.
 */
export function HistorialFactura({ items }: { items: Movimiento[] | null }) {
  return (
    <section className="mt-4">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-text-primary">
        <Icon name="history" size={15} className="text-brand" />
        Historial de la factura
      </div>

      {items === null ? (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 text-[12px] text-text-tertiary shadow-sm">Cargando…</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 text-[12px] text-text-tertiary shadow-sm">
          Sin movimientos registrados.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((m) => {
            const pinta = PINTA[m.tipo] ?? PINTA.EDICION;
            return (
              <li key={m.id} className="rounded-xl border border-border-subtle bg-surface p-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon name={pinta.icon} size={15} className="shrink-0 text-brand" />
                  <span className="text-[13px] font-semibold text-text-primary">{m.titulo}</span>
                  <Badge label={fmtDateTime(m.fecha)} tone={pinta.tone} />
                  {m.por && <span className="text-[11px] text-text-tertiary">por {m.por}</span>}
                </div>

                {/* El "por qué" va destacado: es lo que se buscaba y no estaba. */}
                {m.motivo && (
                  <p className="mt-2 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-[12px] text-text-secondary">
                    <span className="font-semibold text-text-primary">Motivo:</span> {m.motivo}
                  </p>
                )}

                {m.cambios.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-0.5">
                    {m.cambios.map((c, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[12px] text-text-secondary">
                        <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
