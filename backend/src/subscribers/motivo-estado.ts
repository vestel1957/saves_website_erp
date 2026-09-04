/**
 * Partir la nota del historial de estados en QUIÉN y POR QUÉ.
 *
 * `SubscriberStatusHistory` no tiene columna de autor ni de motivo: todo se
 * escribió siempre en una sola frase (`note`), y cada quien la compuso a su
 * manera —«Cambio manual por Fulana: se exonera porque…», «Reconexión
 * automática por pago», «Paso automático a Cartera (cron): 3 facturas
 * pendientes»—. Partirla al LEER (y no cambiar cómo se escribe) es lo que hace
 * que esto valga también para las filas que ya están guardadas y para las que
 * mete el sync desde el legacy, que llegan sin nota ninguna.
 *
 * Sólo el «Cambio manual» lleva autor; en el resto la frase entera ES el
 * motivo, porque quien movió el estado fue el sistema.
 */
export type MotivoEstado = {
  /** Funcionario que movió el estado a mano, si lo hizo una persona. */
  author: string | null;
  /** Lo que se escribió como razón del cambio. */
  reason: string | null;
};

/** «Cambio manual[ por Fulana][: motivo]» — las tres partes son opcionales. */
const CAMBIO_MANUAL = /^Cambio manual(?: por ([^:]+))?(?::\s*([\s\S]+))?$/;

/** Espacios de más: los nombres importados del legacy traen dobles (ver composeName). */
const unEspacio = (v: string) => v.replace(/\s+/g, ' ').trim();

export function partirNotaDeEstado(note?: string | null): MotivoEstado {
  const texto = (note ?? '').trim();
  if (!texto) return { author: null, reason: null };
  const m = CAMBIO_MANUAL.exec(texto);
  if (!m) return { author: null, reason: unEspacio(texto) };
  return {
    author: m[1] ? unEspacio(m[1]) : null,
    reason: m[2] ? unEspacio(m[2]) : null,
  };
}

/** Dos filas del mismo cambio se consideran la misma dentro de esta ventana. */
const ECO_MS = 2000;

/**
 * Quitar los ECOS del sync.
 *
 * El writeback empuja al legacy el estado que se cambió aquí y la ida lo vuelve
 * a traer: como el historial no guarda `legacyId` de estados, el mismo cambio
 * queda dos veces —el nuestro con su nota y el del legacy pelado, con la misma
 * fecha al segundo—. En la ficha eso se lee como si el estado hubiera cambiado
 * dos veces, y la copia sin nota tapa el motivo que se escribió.
 *
 * Recibe el historial ordenado de más nuevo a más viejo y devuelve uno por
 * cambio, quedándose con la fila que SÍ trae nota.
 */
export function sinEcosDelSync<T extends { status: string; date: Date; note?: string | null }>(
  historial: T[],
): T[] {
  const out: T[] = [];
  for (const h of historial) {
    const prev = out[out.length - 1];
    const mismoCambio = prev
      && prev.status === h.status
      && Math.abs(prev.date.getTime() - h.date.getTime()) <= ECO_MS;
    if (!mismoCambio) { out.push(h); continue; }
    // Se queda la que explica el cambio; si ninguna lo explica, da igual cuál.
    if (!prev.note?.trim() && h.note?.trim()) out[out.length - 1] = h;
  }
  return out;
}
