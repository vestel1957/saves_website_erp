/**
 * Mensaje legible de un error capturado.
 *
 * Sustituye al patrón `catch (e) { toast(mensajeDeError(e)) }`, que aparecía 106 veces:
 * `any` desactiva el chequeo justo donde menos se sabe lo que llega — en un `catch`
 * puede venir cualquier cosa, incluida una cadena o `undefined`, y `mensajeDeError(e)`
 * reventaría dentro del propio manejador de errores.
 */
export function mensajeDeError(e: unknown, porDefecto = "Ocurrió un error inesperado"): string {
  if (e instanceof Error && e.message.trim()) return e.message;
  if (typeof e === "string" && e.trim()) return e;
  return porDefecto;
}

/**
 * Lista que llega de la API, o `[]` si no llegó una lista.
 *
 * El patrón `authFetch(x).then((r) => r.json()).then(setLista).catch(() => {})`
 * parece a prueba de balas por el `catch`, pero no lo es: cuando la API responde
 * un error, el cuerpo TAMBIÉN es JSON válido —`{"message":"..."}`— así que
 * `res.json()` no lanza y el `catch` no entra. El estado que debía ser un array
 * pasa a ser un objeto, y el primer `lista.map(...)` del render tumba la
 * pantalla entera con "Algo se rompió en esta pantalla".
 *
 * Fue exactamente lo que pasó en /tareas: un 404 de `/tasks/assignees` (una ruta
 * tapada por `/:id`) llegó a `assignees` y reventó el render. El fallo real era
 * del backend, pero el precio no debería ser la pantalla completa: sin
 * responsables el formulario se degrada, no se cae.
 *
 * Uso: `authFetch(x).then(listaJson).then(setLista)` — ya no hace falta `catch`
 * para el caso del cuerpo de error, aunque conviene dejarlo para la red caída.
 */
// El genérico va por defecto a `any` —y no a `unknown`— para que se pueda pasar
// por referencia, `.then(listaJson)`, que es como se usa en las ~38 llamadas. Con
// `unknown` TypeScript no puede inferir `T` desde el `.then(setX)` siguiente y
// obligaría a escribir el tipo a mano en cada sitio. No se pierde chequeo: lo que
// había antes, `r.json()`, ya devolvía `any`. Quien quiera el tipo puede pedirlo:
// `.then(listaJson<Sede>)`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listaJson<T = any>(res: Response): Promise<T[]> {
  if (!res.ok) return [];
  const d = await res.json().catch(() => null);
  return Array.isArray(d) ? (d as T[]) : [];
}

/**
 * Objeto que llega de la API, o `null` si no llegó uno.
 *
 * Misma trampa que en `listaJson`, con otro final: el cuerpo de error
 * `{"message":"..."}` es un objeto perfectamente válido, así que se cuela en el
 * estado y las pantallas lo tratan como si fueran los datos. Los contadores que
 * hacen `stats?.total ?? 0` lo aguantan mostrando ceros —mal, pero de pie—; los
 * que bajan un nivel (`naps.items.length`) revientan igual que un `.map()`.
 *
 * Devolver `null` deja el estado en su valor inicial, que es justo lo que las
 * pantallas ya saben dibujar mientras cargan.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function objetoJson<T = any>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  const d = await res.json().catch(() => null);
  return d !== null && typeof d === "object" && !Array.isArray(d) ? (d as T) : null;
}
