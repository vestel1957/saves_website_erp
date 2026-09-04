"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { VisitaAgendada, visitaLista, type MiAgenda } from "@/components/soporte/VisitaAgendada";
import { VisitaDeHoy } from "@/components/soporte/VisitaDeHoy";
import { pedirUbicacion } from "@/lib/geo";
import { LoQueViene } from "@/components/soporte/LoQueViene";

const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });

/**
 * Mi agenda: UNA visita, la que toca ahora.
 *
 * Historia corta de esta pantalla, porque explica lo que hay:
 *
 *  · Hasta el 2026-08-04 listaba el día numerado y el número era una sugerencia.
 *  · Del 04 al 28 de agosto fue "turno obligatorio": una sola visita, y el backend le
 *    negaba abrir cualquier otra.
 *  · Del 28 de agosto al 2026-09-02 volvió a verlo todo de una vez.
 *  · Desde el 2026-09-02, a pedido del usuario, **vuelve el turno**: ve una visita y
 *    hasta que no la cierra —o la aparta diciendo por qué no se pudo— no aparece la
 *    siguiente.
 *
 * **Excepción nominal (2026-09-02):** el técnico con `Staff.agendaLibre` —hoy sólo
 * Oscar Rodríguez— ve su jornada completa y abre la que quiera; la manda el backend
 * en `turnoLibre`. Para todos los demás la pantalla es la de una visita a la vez.
 *
 * Enseñar las seis visitas y dejar abrir sólo una sería peor que no enseñarlas:
 * invita a discutir el orden en vez de seguirlo. Lo que sí se dice es cuántas lleva y
 * cuántas le faltan, que es lo que necesita para organizarse.
 *
 * Las que ya cerró NO desaparecen: se recogen abajo, plegadas. Ver las tres hechas es
 * lo que le dice por dónde va, y esconderlas haría que un día completo se viera igual
 * que un día en blanco. Abrir una cerrada es consultar su propio trabajo, no elegir
 * el siguiente: el backend también lo permite.
 *
 * El candado de verdad está en el backend (`support/turno.ts`), y cuál es la visita
 * en turno lo dice ÉL en `enTurno` — esta pantalla no lo recalcula, para que no pueda
 * ofrecer una visita que la API luego rechaza.
 */
export default function MiAgendaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [d, setD] = useState<MiAgenda | null>(null);
  const [err, setErr] = useState(false);
  const [verHechas, setVerHechas] = useState(false);

  const cargar = useCallback(async () => {
    setErr(false);
    try {
      const r = await authFetch("/support/mi-agenda");
      if (!r.ok) throw new Error(String(r.status));
      setD((await r.json()) as MiAgenda);
    } catch {
      setErr(true);
    }
  }, [authFetch]);

  useEffect(() => {
    if (!authLoading) void cargar();
  }, [authLoading, cargar]);

  const { turno, siguientes, hechas, restantes } = useMemo(() => {
    const o = d?.ordenes ?? [];
    const pendientes = o.filter((v) => !visitaLista(v));
    // Exento del turno (`turnoLibre`): la primera sigue arriba como tarjeta grande
    // —es lo que necesita para arrancar— y detrás van TODAS las demás, abribles. Para
    // el resto del equipo `siguientes` va vacío y la pantalla es la de siempre.
    const libre = d?.turnoLibre === true;
    return {
      // La que manda el backend. El respaldo a la primera pendiente es para el caso en
      // que no venga ninguna en turno: ahí el backend tampoco bloquea nada, así que
      // pantalla y API siguen diciendo lo mismo.
      turno: libre
        ? pendientes[0] ?? null
        : pendientes.find((v) => v.id === d?.enTurno) ?? (d?.enTurno ? null : pendientes[0] ?? null),
      siguientes: libre ? pendientes.slice(1) : [],
      hechas: o.filter(visitaLista),
      restantes: pendientes.length,
    };
  }, [d]);

  /**
   * Aparta una visita del día. Devuelve el mensaje de error, o `null` si salió bien.
   *
   * La foto es opcional y va POR SEPARADO, al endpoint de evidencia que ya existe
   * (`/tickets/:id/attach`), y no dentro de este cuerpo. Dos motivos: la imagen
   * queda en el historial de la orden —que es donde la busca quien la reagende, y
   * donde ya se ven las demás fotos del técnico— y se geo-etiqueta con el mismo
   * camino que la evidencia normal, sin duplicar almacén ni permisos.
   *
   * Se sube ANTES de apartar: si la subida falla no se aparta nada, y así el técnico
   * no se queda con la visita fuera de su día y la prueba perdida.
   */
  const apartar = useCallback(
    async (ticketId: string, motivo: string, foto: File | null): Promise<string | null> => {
      if (foto) {
        try {
          const geo = await pedirUbicacion();
          const fd = new FormData();
          fd.append("file", foto);
          fd.append("message", `No se pudo atender: ${motivo}`);
          if (geo.ok) {
            fd.append("lat", String(geo.lat));
            fd.append("lng", String(geo.lng));
          }
          const rf = await authFetch(`/support/tickets/${ticketId}/attach`, { method: "POST", body: fd });
          if (!rf.ok) {
            const cuerpo = await rf.json().catch(() => null);
            return cuerpo?.message ?? "No se pudo subir la foto. Quítala y confirma sin ella, o inténtalo otra vez.";
          }
        } catch {
          return "No se pudo subir la foto, seguramente por la señal. Quítala y confirma sin ella, o inténtalo donde tengas cobertura.";
        }
      }

      try {
        const r = await authFetch("/support/mi-agenda/no-atendida", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketId, motivo }),
        });
        if (!r.ok) {
          const cuerpo = await r.json().catch(() => null);
          return cuerpo?.message ?? "No se pudo guardar. Inténtalo de nuevo.";
        }
        await cargar();
        return null;
      } catch {
        return "No hay conexión. Inténtalo de nuevo cuando tengas señal.";
      }
    },
    [authFetch, cargar],
  );

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d)
    return (
      <div className="p-6">
        <LoadError message="No se pudo cargar tu agenda." onRetry={() => void cargar()} />
      </div>
    );
  if (!d) return <PageSkeleton />;

  const total = d.ordenes.length;

  return (
    <div className="flex flex-col gap-3">
      <PageHeading
        icon="calendar-clock"
        title="Mi trabajo de hoy"
        subtitle={diaLargo(d.fecha).replace(/^./, (c) => c.toUpperCase())}
      />

      {/* Sin ficha de empleado no hay forma de saber qué visitas son suyas. Se dice
          qué pasa y a quién pedírselo, en vez de una pantalla vacía que parece un día
          libre. Mismo criterio que el panel de rendimiento. */}
      {!d.resolved ? (
        <div className="rounded-xl border border-warning-border bg-warning-soft p-4">
          <div className="flex items-start gap-2.5">
            <Icon name="alert-triangle" size={18} className="mt-0.5 shrink-0 text-warning-text" />
            <div className="text-[13px] text-text-primary">
              <div className="font-bold">Tu usuario no está ligado a una ficha de empleado</div>
              <p className="mt-1 text-text-secondary">
                Por eso no podemos saber qué visitas son tuyas. Pídele a administración que revise
                que tu correo sea el mismo en <span className="font-semibold">Empleados</span>.
              </p>
            </div>
          </div>
        </div>
      ) : total > 0 ? (
        <>
          {/* Cuántas lleva y cuántas le faltan. Con una sola tarjeta delante, esto es
              lo que distingue "vas por la 2 de 6" de "esto es todo lo que hay". */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5">
            <p className="text-[13px] text-text-secondary">
              <b className="text-text-primary">
                {restantes} {restantes === 1 ? "visita" : "visitas"} por hacer
              </b>
              {hechas.length > 0 ? ` · ${hechas.length} ${hechas.length === 1 ? "hecha" : "hechas"}` : ""} de {total}
            </p>
            <p className="text-[11.5px] text-text-tertiary">
              {d.turnoLibre
                ? "Este es el orden que puso la persona de caja; puedes abrir la que necesites."
                : "En el orden que puso la persona de caja."}
            </p>
          </div>

          {turno ? (
            <>
              <VisitaDeHoy
                o={turno}
                posicion={turno.puesto ?? hechas.length + 1}
                total={total}
                libre={d.turnoLibre === true}
                onApartada={apartar}
              />
              {restantes > 1 && !d.turnoLibre && (
                <p className="text-center text-[12px] text-text-tertiary">
                  Cuando cierres esta te aparece la siguiente. Te quedan {restantes} de {total}.
                </p>
              )}
              {/* Sólo para el técnico exento del turno: el resto de su jornada, entera
                  y abrible. Va DEBAJO de la tarjeta grande y no en su lugar para que
                  siga viéndose por dónde empezar. */}
              {siguientes.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-[12px] font-semibold text-text-secondary">
                    Las demás de tu día ({siguientes.length})
                  </p>
                  {siguientes.map((o) => (
                    <VisitaAgendada key={o.id} o={o} />
                  ))}
                </div>
              )}
            </>
          ) : (
            // Terminó el día. Es la única pantalla del sistema que da una
            // felicitación, y se la ha ganado: cerró todo lo que le pusieron.
            <div className="rounded-xl border border-success-border bg-success-soft p-6 text-center">
              <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface text-success-text">
                <Icon name="check" size={22} />
              </span>
              <h2 className="text-[15px] font-bold text-text-primary">Terminaste tus visitas de hoy</h2>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
                Cerraste las {total} que tenías agendadas. Si aparece algo nuevo, lo verás aquí.
              </p>
            </div>
          )}

          {hechas.length > 0 && (
            <div className="rounded-xl border border-border-subtle bg-surface">
              <button
                type="button"
                onClick={() => setVerHechas((v) => !v)}
                className="tap flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left"
              >
                <span className="flex items-center gap-2 text-[13px] font-semibold text-text-secondary">
                  <Icon name="check" size={15} className="text-success-text" />
                  Ya hechas ({hechas.length})
                </span>
                <Icon name={verHechas ? "chevron-up" : "chevron-down"} size={16} className="text-text-tertiary" />
              </button>
              {verHechas && (
                <div className="flex flex-col gap-2 border-t border-border-subtle p-3">
                  {hechas.map((o) => (
                    <VisitaAgendada key={o.id} o={o} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-tertiary">
            <Icon name="calendar-clock" size={20} />
          </span>
          <h2 className="text-[14px] font-bold text-text-primary">No tienes visitas agendadas para hoy</h2>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
            Quien reparte el día es la persona de caja. Si crees que es un error, háblale antes de
            salir.
          </p>
          <Link
            href="/soporte"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3.5 py-2 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            <Icon name="clipboard-check" size={14} /> Ver mis órdenes
          </Link>
        </div>
      )}

      {/* Lo que le viene, en solo lectura y plegado (2026-08-26). Es un resumen para
          que pueda organizarse —llevar material, saber que mañana le toca al otro lado
          del pueblo—; lo de hoy ya lo tiene entero arriba. */}
      <LoQueViene cuantas={d.proximas} />
    </div>
  );
}
