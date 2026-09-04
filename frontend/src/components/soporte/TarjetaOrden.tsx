"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { TecChip } from "@/components/soporte/TecChip";
import {
  type TicketRow,
  TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_PRIORITY_TONE,
} from "@/lib/support";

/**
 * Una orden vista en un móvil.
 *
 * La tarjeta automática de `DataTable` (una fila etiqueta/valor por columna) no
 * aguanta un listado de diez columnas: salían 355 px por orden —etiquetas en
 * mayúsculas a la izquierda, valores a la derecha, "DESCRIPCIÓN —" ocupando un
 * renglón entero— y en una pantalla de 390 px cabía UNA orden. Para recorrer 25
 * había que bajar nueve pantallas.
 *
 * Aquí la misma fila se ordena por lo que se pregunta al mirar una lista de
 * órdenes en la calle: **qué es, cómo está, de quién, dónde y de quién es la
 * visita**. Nada se esconde que no esté a un toque de distancia: el resto (la
 * descripción larga, el seguimiento, el equipo) vive en el detalle, que es donde
 * se usa.
 *
 * La misma tarjeta sirve a las dos pantallas de soporte —la general y "Mis
 * órdenes"— con dos ajustes: el técnico no necesita repetir su nombre en cada
 * tarjeta (`ocultarTecnico`) y sólo la vista general enlaza al cliente.
 */
export function TarjetaOrden({
  r,
  ocultarTecnico = false,
  enlazarCliente = true,
}: {
  r: TicketRow;
  /** En "Mis órdenes" todas son suyas: repetir su nombre 25 veces es ruido. */
  ocultarTecnico?: boolean;
  /** El nombre del cliente lleva a su ficha (no en la vista del técnico). */
  enlazarCliente?: boolean;
}) {
  const donde = [r.sede, r.barrio].filter(Boolean).join(" · ");
  const fecha = new Date(r.created).toLocaleDateString("es-CO");

  return (
    <div className="flex flex-col gap-1.5 p-3">
      {/* Qué es y cómo está: las dos preguntas que se hacen primero, en el
          renglón que se lee primero. */}
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-[14px] font-semibold leading-snug text-text-primary">{r.type}</span>
        <span className="shrink-0">
          <Badge label={TICKET_STATUS_LABEL[r.status] ?? r.status} tone={TICKET_STATUS_TONE[r.status] ?? "default"} />
        </span>
      </div>

      {/* Identificación: el número (que es lo que se dicta por radio o teléfono),
          la clase de orden y la prioridad cuando la lleva. */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="font-mono text-[12px] font-semibold text-text-secondary">N.º {r.code ?? r.legacyId}</span>
        {r.subject && r.subject !== r.type && (
          <span className="text-[11px] text-text-tertiary">· {r.subject}</span>
        )}
        {r.priority && <Badge label={r.priority} tone={TICKET_PRIORITY_TONE[r.priority] ?? "default"} />}
      </div>

      {r.client && (
        <Dato icono="user">
          {enlazarCliente && r.subscriberId ? (
            <Link
              href={`/clientes/${r.subscriberId}`}
              onClick={(e) => e.stopPropagation()}
              className="font-medium text-brand hover:underline"
            >
              {r.client}
            </Link>
          ) : (
            <span className="font-medium text-text-primary">{r.client}</span>
          )}
        </Dato>
      )}

      {donde && <Dato icono="map-pin">{donde}</Dato>}

      {/* La descripción sólo cuando la hay: en las órdenes heredadas del legacy
          viene vacía casi siempre, y un "—" repetido no es información. */}
      {r.description?.trim() && (
        <p className="line-clamp-2 text-[12px] leading-snug text-text-secondary">{r.description}</p>
      )}

      {/* Pie: de quién es la visita y de cuándo viene la orden. Debajo de la fecha,
          quién la generó — a quién preguntarle si no se entiende. */}
      <div className="mt-0.5 flex items-end justify-between gap-2 border-t border-border-subtle pt-2">
        {ocultarTecnico ? <span /> : <TecChip name={r.assigned} />}
        <div className="flex min-w-0 flex-col items-end text-right">
          <span className="whitespace-nowrap text-[12px] text-text-secondary">{fecha}</span>
          {r.generadaPor && (
            <span className="max-w-[150px] truncate text-[11px] text-text-tertiary">por {r.generadaPor}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Renglón de dato con icono: mismo alto y misma sangría para todos. */
function Dato({ icono, children }: { icono: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-secondary">
      <Icon name={icono} size={13} className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}
