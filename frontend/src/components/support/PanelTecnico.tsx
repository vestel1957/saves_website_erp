"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { ChartCard, ChartEmpty } from "@/components/charts";
import { useAuth } from "@/context/AuthProvider";
import { type MiRendimiento } from "@/lib/support";

const pctTxt = (n: number | null | undefined) => (n == null ? "—" : `${n}%`);
const fechaCorta = (iso: string) =>
  new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString("es-CO", { day: "2-digit", month: "short" }).replace(".", "");

/**
 * Una métrica del rendimiento propio, con la referencia del equipo al lado.
 *
 * La referencia no es decoración: un 12% de re-visita no significa nada suelto. Al
 * lado de la mediana del equipo sí — y es la diferencia entre un número que motiva y
 * uno que solo asusta.
 */
function Metrica({ label, valor, referencia, hint, tono = "default" }: { label: string; valor: string; referencia?: string; hint?: string; tono?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border-subtle bg-surface p-3.5">
      <span className="text-[11.5px] font-semibold text-text-secondary">{label}</span>
      <span className={`text-[20px] font-bold leading-none ${tono === "success" ? "text-success-text" : tono === "error" ? "text-error-text" : tono === "warning" ? "text-warning-text" : "text-text-primary"}`}>
        {valor}
      </span>
      {referencia && <span className="text-[10.5px] text-text-tertiary">{referencia}</span>}
      {hint && <span className="text-[10.5px] text-text-tertiary">{hint}</span>}
    </div>
  );
}

/**
 * El panel del técnico: SU RENDIMIENTO, y nada más.
 *
 * Hasta 2026-07-31 este panel abría con la cola de órdenes del día (agenda, rezago y
 * contadores) y el rendimiento iba debajo. Se quitó todo lo de órdenes por decisión
 * del usuario: el trabajo del día se atiende en `/soporte`, que ya está acotado a las
 * órdenes asignadas a él (`SupportService.tickets` → `soloMisOrdenes`), y tenerlo
 * duplicado en dos sitios hacía que ninguno de los dos fuera "el" lugar.
 *
 * Lo que queda sale del MISMO servicio que el tablero de gerencia
 * (`/support/mi-rendimiento` → `PerformanceService`): el técnico ve exactamente lo que
 * ve su jefe, con la mediana del equipo como referencia y sin nombres de terceros.
 */
export function PanelTecnico() {
  const { authFetch, user } = useAuth();
  const [r, setR] = useState<MiRendimiento | null>(null);
  const [err, setErr] = useState(false);
  const [verCasos, setVerCasos] = useState(false);

  const cargar = useCallback(() => {
    setErr(false);
    void authFetch("/support/mi-rendimiento")
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
      .then(setR)
      .catch(() => setErr(true));
  }, [authFetch]);

  useEffect(() => { cargar(); }, [cargar]);

  if (err && !r) return <div className="p-6"><LoadError message="No se pudo cargar tu rendimiento." onRetry={cargar} /></div>;
  if (!r) return <PageSkeleton />;

  const saludo = user?.name ? `Hola, ${user.name.split(" ")[0]}` : "Mi rendimiento";

  // Sin ficha de empleado no hay forma de saber qué trabajo es suyo. Se dice qué pasa
  // y a quién pedirle el arreglo, en vez de un panel en ceros que parece un mal mes.
  if (!r.resolved) {
    return (
      <>
        <PageHeading icon="gauge" title={saludo} subtitle="Tu rendimiento" />
        <div className="rounded-xl border border-warning-border bg-warning-soft p-4">
          <div className="flex items-start gap-2.5">
            <Icon name="alert-triangle" size={18} className="mt-0.5 shrink-0 text-warning-text" />
            <div className="text-[13px] text-text-primary">
              <div className="font-bold">Tu usuario no está ligado a una ficha de empleado</div>
              <p className="mt-1 text-text-secondary">
                Por eso no podemos saber cuál trabajo es tuyo. Pídele a administración que revise que tu
                correo sea el mismo en <span className="font-semibold">Empleados</span>.
              </p>
              <Link href="/soporte" className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand hover:underline">
                Ver mis órdenes de trabajo <Icon name="chevron-right" size={13} />
              </Link>
            </div>
          </div>
        </div>
      </>
    );
  }

  const res = r?.resumen ?? null;
  const eq = r?.equipo ?? null;
  // En la re-visita, MENOS es mejor: el tono se compara contra la mediana del equipo.
  const tonoRevisita =
    res?.revisitaPct == null || eq?.medianaRevisita == null
      ? "default"
      : res.revisitaPct <= eq.medianaRevisita
        ? "success"
        : res.revisitaPct <= eq.medianaRevisita * 1.5
          ? "warning"
          : "error";

  return (
    <>
      <PageHeading
        icon="gauge"
        title={saludo}
        subtitle="Cómo va tu trabajo de campo · las mismas métricas que ve tu jefe"
      />

      {/* Mi rendimiento — las mismas métricas que ve gerencia */}
      <ChartCard
        title="Mi rendimiento"
        subtitle={
          res && eq
            ? `Trabajo de campo de los últimos 90 días · la re-visita mide si el cliente volvió a llamar en ${eq.ventanaRevisitaDias} días`
            : "Trabajo de campo de los últimos 90 días"
        }
        icon="gauge"
      >
        {!res ? (
          <ChartEmpty message="Todavía no hay órdenes de campo cerradas a tu nombre en el periodo." />
        ) : (
          <div className="flex flex-col gap-4">
            {!res.muestraSuficiente && (
              <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[11.5px] text-text-secondary">
                <Icon name="info" size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
                <span>
                  Llevas {res.cerradas} {res.cerradas === 1 ? "orden cerrada" : "órdenes cerradas"} de campo en el periodo.
                  Con menos de {eq?.muestraMinima ?? 5} los porcentajes se mueven demasiado con una sola orden: tómalos como
                  referencia, no como nota.
                </span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <Metrica
                label="Volvieron a llamar (re-visita)"
                valor={pctTxt(res.revisitaPct)}
                referencia={eq?.medianaRevisita != null ? `Mediana del equipo: ${eq.medianaRevisita}%` : undefined}
                hint={`${res.revisitas} de ${res.cerradas} cerradas`}
                tono={tonoRevisita}
              />
              <Metrica label="Órdenes cerradas" valor={String(res.cerradas)} hint={`${res.asignadas} asignadas en el periodo`} />
              <Metrica
                label="Cerradas con foto"
                valor={pctTxt(res.evidenciaPct)}
                referencia={eq?.medianaEvidencia != null ? `Mediana del equipo: ${eq.medianaEvidencia}%` : undefined}
              />
              <Metrica label="Cerradas con firma" valor={pctTxt(res.firmaPct)} />
            </div>

            {r.porTipo.length > 0 && (
              <div>
                <div className="mb-2 text-[12px] font-bold text-text-primary">Por tipo de trabajo</div>
                <div className="-mx-1 overflow-x-auto px-1">
                  <table className="w-full min-w-[380px] text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10.5px] uppercase tracking-wide text-text-tertiary">
                        <th className="pb-1.5 font-semibold">Tipo</th>
                        <th className="pb-1.5 text-right font-semibold">Cerradas</th>
                        <th className="pb-1.5 text-right font-semibold">Volvieron</th>
                        <th className="pb-1.5 text-right font-semibold">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.porTipo.map((t) => (
                        <tr key={t.tipo} className="border-b border-border-subtle last:border-0">
                          <td className="py-1.5 pr-2 text-text-primary">{t.tipo}</td>
                          <td className="py-1.5 text-right text-text-secondary">{t.cerradas}</td>
                          <td className="py-1.5 text-right text-text-secondary">{t.revisitas}</td>
                          <td className={`py-1.5 text-right font-semibold ${t.revisitaPct ? "text-text-primary" : "text-text-tertiary"}`}>{pctTxt(t.revisitaPct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Los casos concretos: un porcentaje no se puede revisar, una orden sí. */}
            {r.casos.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setVerCasos((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand hover:underline"
                >
                  <Icon name={verCasos ? "chevron-up" : "chevron-down"} size={14} />
                  {verCasos ? "Ocultar" : "Ver"} las {r.casos.length} órdenes donde el cliente volvió a llamar
                </button>
                {verCasos && (
                  <div className="mt-2 flex flex-col">
                    {r.casos.map((k) => (
                      <Link
                        key={k.id}
                        href={`/soporte/${k.id}`}
                        className="flex items-center justify-between gap-3 border-b border-border-subtle py-2 text-[12px] last:border-0 hover:text-brand"
                      >
                        <span className="min-w-0">
                          <span className="font-semibold">#{k.code ?? "—"}</span> {k.tipo}
                          <span className="block truncate text-[11px] text-text-tertiary">
                            {k.cliente ?? k.abonado ?? "Sin cliente"} · volvió con «{k.queja}»
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-text-tertiary">
                          {fechaCorta(k.fecha)} → {k.quejaFecha ? fechaCorta(k.quejaFecha) : "—"}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </ChartCard>
    </>
  );
}
