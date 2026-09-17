import { partirDocumentacion } from './soluciones';

/**
 * El técnico no cierra una orden sin documentarla (2026-09-17, a pedido del usuario:
 * «tenemos que obligarlos a documentar las órdenes; sí o sí para cerrar una orden
 * tiene que haberla documentado»).
 *
 * Documentada quiere decir, en ESA orden y escrito por QUIEN la cierra:
 *  - un renglón del seguimiento con la solución de la lista y un detalle de al menos
 *    `MIN_DETALLE` letras (lo que arma el formulario «Documentar»), y
 *  - al menos una foto.
 *
 * A diferencia de la foto de `foto-cierre.policy.ts`, vale para TODA orden que cierre
 * un técnico de campo, no sólo las de campo: el usuario lo pidió "siempre". Lo que
 * sigue fuera es lo que no es un técnico cerrando su trabajo: los procesos internos
 * (el cron que reconecta al pagar cierra sin usuario) y el personal de mando, que
 * cierra desde la oficina lo que otro hizo. Tampoco las órdenes sin número: el hilo
 * cuelga del número y sin él no hay dónde documentar.
 *
 * Tiene que ser suyo: la nota que dejó soporte al crear la orden no documenta la visita.
 */
export const MIN_DETALLE = 20;

export type RenglonHilo = { message: string | null; attach: string | null; authorId: string | null };

export type EntradaDocumentacion = {
  /** `TICKET_REQUIRE_DOCUMENTATION=false` lo apaga. */
  activo: boolean;
  /** ¿Quien cierra es un técnico de campo? (`esTecnicoDeCampo`) */
  esTecnico: boolean;
  userId: string | null;
  tieneNumero: boolean;
  renglones: RenglonHilo[];
};

export type FaltaDocumentar = { foto: boolean; documentacion: boolean };

export const SIN_DOCUMENTAR =
  'Para cerrar la orden tienes que documentarla: escoge la solución, escribe qué hiciste (mínimo 20 letras) y sube al menos una foto.';

export const estaDocumentado = (msg: string | null) => {
  const { solucion, detalle } = partirDocumentacion(msg);
  return solucion != null && detalle.length >= MIN_DETALLE;
};

/** Qué le falta; `null` si no aplica o ya está todo. */
export function faltaDocumentar(e: EntradaDocumentacion): FaltaDocumentar | null {
  if (!e.activo || !e.esTecnico || !e.userId || !e.tieneNumero) return null;
  const suyos = e.renglones.filter((r) => r.authorId === e.userId);
  const falta = {
    foto: !suyos.some((r) => r.attach),
    documentacion: !suyos.some((r) => estaDocumentado(r.message)),
  };
  return falta.foto || falta.documentacion ? falta : null;
}
