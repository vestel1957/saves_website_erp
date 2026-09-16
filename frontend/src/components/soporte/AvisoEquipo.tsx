"use client";

import { Icon } from "@/components/Icon";

/**
 * El equipo que una orden se lleva del estante, tal como viaja en las tarjetas de la
 * agenda y en la ficha del abonado.
 *
 * `equipo` dentro en `null` NO es "no hace falta equipo": estas órdenes solo llegan
 * aquí cuando lo piden (instalación, cambio de equipo, migración, agregar internet,
 * traslado), así que un null es "hace falta y no hay ninguno apartado".
 */
export type EquipoDeOrden = {
  equipo: {
    id: string; code: number; serial: string | null; bodega: string | null;
    /**
     * `reserva` = se apartó del estante para esta orden y hay que entregarla.
     * `asignado` = ya figura a nombre del cliente (se la entregaron antes, o viene
     * así del legacy): no hay nada que sacar, es ESA la que se instala.
     */
    origen?: "reserva" | "asignado";
  } | null;
} | null;

/**
 * "Lleve equipo": el aviso de que esta visita no se atiende con las manos vacías.
 *
 * Lo pide el usuario (2026-09-04) para las órdenes de instalación, cambio de equipo,
 * migración y agregar internet: el sistema ya aparta una unidad a nombre del cliente
 * al abrir la orden (`EquipoReservaService`), pero eso sólo se veía entrando en la
 * orden — quien reparte el día y quien atiende en la ventanilla veían una visita
 * igual a todas las demás, y el técnico salía sin la caja.
 *
 * Dos formas, y la diferencia importa más que el texto:
 *  - En AZUL, con número: la unidad ya está apartada y es ÉSA la que hay que llevar
 *    (si el técnico instala otra, la ONU no se autentica sola).
 *  - En ÁMBAR: la orden pide equipo y no hay ninguno apartado — hay que sacarlo de
 *    la bodega a mano. Es el aviso que de verdad cambia lo que alguien tiene que
 *    hacer, así que se pinta como advertencia y no como dato.
 *
 * Vive fuera de `agenda/comun.tsx` para que la agenda del técnico —un móvil, en la
 * calle— pueda usarlo sin arrastrar la barra de filtros del agendamiento.
 */
export function AvisoEquipo({ equipo, className = "" }: { equipo?: EquipoDeOrden; className?: string }) {
  if (!equipo) return null;
  const e = equipo.equipo;
  const detalle = e
    ? [e.serial ? `S/N ${e.serial}` : null, e.bodega ? `bodega ${e.bodega}` : null].filter(Boolean).join(" · ")
    : "";
  // Ya suyo vs. apartado: la caja del cliente puede estar en su casa, así que el
  // aviso dice cuál es la suya en vez de mandar a buscarla al estante.
  const suyo = e?.origen === "asignado";
  return (
    <span
      title={
        e
          ? suyo
            ? `El equipo de este cliente es el ${e.code}${detalle ? ` (${detalle})` : ""}: ya está a su nombre y es el que se autentica solo.`
            : `Llévese el equipo ${e.code}${detalle ? ` (${detalle})` : ""}: está apartado a nombre de este cliente y es el que se autentica solo.`
          : "Esta visita necesita equipo y el cliente no tiene ninguno asignado: hay que sacarlo de la bodega y asignárselo."
      }
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${
        e ? "bg-info-soft text-info-text" : "bg-warning-soft text-warning-text"
      } ${className}`}
    >
      <Icon name={e ? "package" : "package-x"} size={10} className="shrink-0" />
      {e ? `${suyo ? "Su equipo" : "Llevar equipo"} ${e.code}` : "Llevar equipo · sin asignar"}
    </span>
  );
}
