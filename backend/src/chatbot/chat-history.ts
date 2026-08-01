import type { Turn } from '@s4gk/wa-agent';

/**
 * Recorta el historial de una conversación SIN romperlo.
 *
 * El problema que resuelve, que dejó a un superusuario sin bot durante casi dos días:
 * el historial se guardaba con un `slice(-20)` a secas. Ese corte cae donde caiga, y
 * si parte un turno de herramienta por la mitad —el `assistant` que la pidió se queda
 * fuera y su resultado `tool` dentro— la ventana empieza con un resultado huérfano.
 * OpenAI rechaza eso con un 400:
 *
 *   "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'"
 *
 * Y como el historial corrupto se vuelve a mandar en CADA mensaje siguiente, la
 * conversación queda envenenada para siempre: la persona solo ve "Tuve un problema
 * procesando tu solicitud" una y otra vez, sin nada que pueda hacer. No se arregla
 * escribiendo otra cosa ni esperando; hay que limpiarle la sesión a mano.
 *
 * Reglas (las tres son la misma idea: el par pedido→respuesta viaja junto o no viaja):
 *
 *  1. Un `tool` cuyo `toolCallId` no fue anunciado por un `assistant` anterior se cae.
 *  2. Un `assistant` con `toolCalls` al que le falta alguna respuesta se cae con las
 *     respuestas parciales que hubiera: pasa cuando el proceso muere a mitad de turno,
 *     y OpenAI lo rechaza igual por el lado contrario.
 *  3. El recorte se hace ANTES de sanear, para que el saneo limpie justo el destrozo
 *     que produjo el recorte.
 */
export function sanearHistorial(turns: Turn[]): Turn[] {
  if (!Array.isArray(turns)) return [];

  const out: Turn[] = [];
  /** Índice del `assistant` que abrió el bloque de herramientas en curso. */
  let abridor = -1;
  /** Ids de llamada anunciados por ese assistant y aún sin respuesta. */
  let esperando = new Set<string>();

  /** Deshace un bloque de herramientas incompleto (el assistant y sus respuestas). */
  const descartarBloque = () => {
    if (abridor >= 0) out.length = abridor;
    abridor = -1;
    esperando = new Set();
  };

  for (const t of turns) {
    if (!t || typeof t !== 'object') continue;

    if (t.role === 'tool') {
      // Huérfano: su petición quedó fuera de la ventana. Es exactamente el caso que
      // rompía la conversación.
      if (!esperando.has(t.toolCallId)) continue;
      esperando.delete(t.toolCallId);
      out.push(t);
      if (!esperando.size) abridor = -1; // bloque completo: ya no hay nada que deshacer
      continue;
    }

    // Cualquier turno que no sea `tool` cierra el bloque anterior. Si quedaban
    // respuestas pendientes, ese bloque está incompleto y se va entero.
    if (esperando.size) descartarBloque();

    if (t.role === 'assistant' && t.toolCalls?.length) {
      abridor = out.length;
      esperando = new Set(t.toolCalls.map((c) => c.id));
    }
    out.push(t);
  }

  // Un bloque abierto al final (el modelo pidió herramientas y nunca llegó la
  // respuesta) también revienta la siguiente llamada: fuera.
  if (esperando.size) descartarBloque();

  return out;
}

/** Recorta a los últimos `max` turnos y sanea lo que el corte haya podido romper. */
export function recortarHistorial(turns: Turn[], max: number): Turn[] {
  if (!Array.isArray(turns)) return [];
  return sanearHistorial(turns.slice(-max));
}
