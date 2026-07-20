/**
 * Mensaje legible de un error capturado.
 *
 * Sustituye al patrón `catch (e) { toast(mensajeDeError(e)) }`, que aparecía 106 veces:
 * `any` desactiva el chequeo justo donde menos se sabe lo que llega — en un `catch`
 * puede venir cualquier cosa, incluida una cadena o `undefined`, y `mensajeDeError(e)`
 * reventaría dentro del propio manejador de errores.
 */
export function mensajeDeError(e: unknown, porDefecto = "Ocurrió un error inesperado"): string {
  if (e instanceof Error && mensajeDeError(e)) return mensajeDeError(e);
  if (typeof e === "string" && e.trim()) return e;
  return porDefecto;
}
