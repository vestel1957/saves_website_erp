"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

/** Una línea del parte: qué pasó con UN cliente del lote. */
export type FilaDelLote = {
  subscriberId?: string;
  abonado?: number | null;
  name?: string | null;
  ok: boolean;
  /** Lo que pasó, en una frase. */
  detalle?: string | null;
  /** Detalle técnico (pasos del router, error del ACS…), en letra pequeña. */
  pasos?: string | null;
  /** Por dónde se hizo, cuando hay más de una vía (TR-069 / OLT). */
  via?: string | null;
  /** Ni CPE ni ONU: no se pudo ni intentar. Se cuenta aparte de los fallos. */
  sinEquipo?: boolean;
};

/** Todo lo que hay que enseñar de un lote ya ejecutado. */
export type ParteDelLote = {
  titulo: string;
  /** Frase de cabecera: "Se cortó a 47 de 50 clientes". */
  resumen: string;
  dryRun: boolean;
  /** Aviso del dry-run, en las palabras del servicio que corresponda. */
  avisoDryRun?: string;
  /** Contadores que se pintan como chips. Se omiten los que valen 0. */
  chips: { label: string; valor: number; tono: "success" | "error" | "warning" | "default" }[];
  filas: FilaDelLote[];
  /** Qué decir cuando no hay filas que listar (p. ej. "ninguno falló"). */
  vacio?: string;
};

/**
 * El parte del trabajo tras una operación masiva.
 *
 * Antes esto era un toast de una línea que se iba solo a los 4 segundos: "Corte:
 * 47/50 OK". Con eso nadie podía saber a QUIÉN no se le cortó, ni por qué, ni si
 * hacía falta ir a mirar un router — y sobre un lote de 50 clientes reales eso es
 * justo lo que hay que saber al terminar. Aquí queda el listado entero, cliente por
 * cliente, con el motivo de cada fallo, y no se cierra hasta que quien lo mandó lo
 * haya leído.
 *
 * Arranca enseñando el lote ENTERO —la pregunta que se hace quien acaba de darle al
 * botón es "¿salió bien?"— con un filtro a mano para quedarse solo con los que no
 * salieron, que es la lista de pendientes cuando el lote es de 500.
 */
export function ParteDelLoteModal({ parte, onClose }: { parte: ParteDelLote | null; onClose: () => void }) {
  const [soloProblemas, setSoloProblemas] = useState(false);

  const problemas = useMemo(() => (parte?.filas ?? []).filter((f) => !f.ok).length, [parte]);
  const visibles = useMemo(
    () => (soloProblemas ? (parte?.filas ?? []).filter((f) => !f.ok) : parte?.filas ?? []),
    [parte, soloProblemas],
  );

  if (!parte) return null;

  const todoBien = problemas === 0 && parte.filas.length > 0;
  const icono = todoBien ? "check" : problemas === parte.filas.length ? "x" : "alert-triangle";
  const tonoIcono = todoBien ? "text-success-text" : problemas === parte.filas.length ? "text-error-text" : "text-warning-text";

  return (
    <Modal
      open
      onClose={() => { setSoloProblemas(false); onClose(); }}
      title={parte.titulo}
      maxWidth="max-w-3xl"
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <Icon name={icono} size={20} className={`mt-0.5 shrink-0 ${tonoIcono}`} />
          <p className="text-[14px] font-semibold text-text-primary">{parte.resumen}</p>
        </div>

        {parte.dryRun && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-[13px] text-warning-text">
            <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0" />
            <span>
              <b>Simulación (dry-run).</b> {parte.avisoDryRun ?? "No se tocó ningún equipo: esto es lo que HABRÍA pasado."}
            </span>
          </div>
        )}

        {parte.chips.some((c) => c.valor > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {parte.chips.filter((c) => c.valor > 0).map((c) => (
              <Badge key={c.label} tone={c.tono} label={`${c.valor} ${c.label}`} />
            ))}
          </div>
        )}

        {problemas > 0 && (
          <label className="flex items-center gap-2 text-[13px] text-text-secondary">
            <input type="checkbox" checked={soloProblemas} onChange={(e) => setSoloProblemas(e.target.checked)} />
            Ver solo los {problemas} que no salieron
          </label>
        )}

        <div className="max-h-[46vh] overflow-y-auto rounded-xl border border-border-subtle">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-surface-2">
              <tr className="border-b border-border-subtle text-left text-text-tertiary">
                <th className="w-10 py-2 pr-4 pl-3 text-right font-medium tabular-nums">#</th>
                <th className="py-2 pr-3 font-medium">Abonado</th>
                <th className="py-2 pr-3 font-medium">Cliente</th>
                <th className="py-2 pr-3 font-medium">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {visibles.length === 0 ? (
                <tr><td colSpan={4} className="py-6 text-center text-text-tertiary">{parte.vacio ?? "Sin filas que mostrar."}</td></tr>
              ) : visibles.map((f, i) => (
                <tr key={f.subscriberId ?? i} className="border-b border-border-subtle/60 align-top">
                  <td className="py-1.5 pr-4 pl-3 text-right tabular-nums text-text-tertiary">{i + 1}</td>
                  <td className="py-1.5 pr-3 font-mono">{f.abonado ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-text-primary">{f.name ?? "—"}</td>
                  <td className="py-1.5 pr-3">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        tone={f.ok ? "success" : f.sinEquipo ? "warning" : "error"}
                        label={f.ok ? "Hecho" : f.sinEquipo ? "Sin equipo" : "Falló"}
                      />
                      {f.via && <span className="text-[11px] text-text-tertiary">{f.via}</span>}
                    </span>
                    {f.detalle && <span className="mt-0.5 block text-text-secondary">{f.detalle}</span>}
                    {f.pasos && <span className="mt-0.5 block text-[11px] text-text-tertiary">{f.pasos}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => { setSoloProblemas(false); onClose(); }}>Cerrar</Button>
        </div>
      </div>
    </Modal>
  );
}
