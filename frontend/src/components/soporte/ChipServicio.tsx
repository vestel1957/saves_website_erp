import { Icon } from "@/components/Icon";
import { SERVICIO_CONTRATADO, type ServicioContratado } from "@/lib/support";

/**
 * QUÉ TIENE CONTRATADO EL CLIENTE de esta orden, para verlo sin abrirla.
 *
 * El problema que resuelve (2026-09-10): en la lista de órdenes había que abrir una
 * por una las reconexiones para saber a quién había que tocarle sólo la televisión
 * —la TV se toca en el CPE o en el puerto CATV de la OLT, y el internet en el
 * Mikrotik—.
 *
 * DICE "Solo TV", no "TV", y ésa es toda la diferencia con la primera versión: el
 * cartel se sacaba del NOMBRE de la orden ('Reconexion Television' → TV) y marcaba
 * de televisión a 33 de los 38 clientes con una 'Reconexion Television2' abierta
 * que tienen también internet. Quien reparte el trabajo lo leía como "de solo TV" y
 * tenía que abrirla igual. El nombre de la orden ya está escrito al lado, en su
 * columna; lo que no se veía es esto.
 *
 * Va con ICONO Y PALABRA a propósito, nunca sólo el color: es la misma regla que
 * los cortes de la ficha del cliente. El fondo se queda neutro porque en la misma
 * fila ya hay dos pastillas de color con significado (estado y prioridad) y una
 * tercera compitiendo las apaga a las tres; el color va sólo en el icono —dorado
 * la televisión, azul el internet—, que es donde distingue sin gritar.
 *
 * No pinta nada cuando la orden no va de un servicio ('Instalacion', 'Cambio de
 * equipo') ni cuando del cliente no consta el plan: un cartel inventado en media
 * lista no distinguiría nada.
 */
export function ChipServicio({ servicio, corto = true }: { servicio?: ServicioContratado | null; corto?: boolean }) {
  if (!servicio) return null;
  const s = SERVICIO_CONTRATADO[servicio];
  if (!s) return null;
  const tinte = servicio === "INTERNET" ? "text-info-text" : servicio === "TV" ? "text-warning-text" : "text-text-tertiary";
  return (
    <span
      title={`El cliente tiene ${s.label.toLowerCase()}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-semibold text-text-secondary"
    >
      <Icon name={s.icono} size={11} className={tinte} />
      {corto ? s.corto : s.label}
    </span>
  );
}
