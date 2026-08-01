/**
 * ¿El cliente está diciendo que su servicio SÍ quedó funcionando, que NO, o algo que
 * no es ni lo uno ni lo otro?
 *
 * Se le pregunta cuando se cierra una orden abierta desde WhatsApp (ver
 * `TicketConfirmacionService`) y la respuesta decide si el caso se cierra o si sale un
 * técnico. Por eso NO lo interpreta el modelo: un "sí" inventado cierra en falso la
 * avería de alguien que sigue sin internet.
 *
 * Es la parte que SAM tenía mal. Su versión (`app.py`,
 * `_manejar_confirmacion_resuelto`) comparaba SUBCADENAS contra el mensaje completo:
 *
 *     palabras_negativas = ['no', 'sigue', ...]
 *     es_negativo = any(p in mensaje_lower for p in palabras_negativas)
 *
 * Con eso, un cliente que contestaba "bueno" quedaba clasificado como NEGATIVO —"no"
 * vive dentro de "bue-no"— y disparaba una re-visita que nadie necesitaba. Y "sigue"
 * contiene "si", así que "sigue igual" salía positivo y negativo a la vez.
 *
 * Aquí se compara por PALABRAS, y además:
 *
 *  - **Se parte en frases** por comas y por conectores de contraste. "no, ya quedó" no
 *    es lo mismo que "no me quedó", y "sí pero sigue lento" tampoco es un sí.
 *  - **Manda la última frase decisiva**: así se escribe en chat ("ya quedó… no,
 *    mentiras, sigue igual").
 *  - **Una negación anula el positivo que le sigue** dentro de su frase ("no me
 *    funciona" no cuenta como "funciona").
 *  - **Ante la duda, no adivina**: devuelve 'no-claro' y quien llama le pasa el mensaje
 *    al bot para que lo atienda como una consulta normal. SAM insistía con "responde
 *    'sí' o 'no'" y dejaba al cliente atrapado si lo que quería era otra cosa.
 */

export type Veredicto = 'si' | 'no' | 'no-claro';

/** Confirman que el servicio quedó bien. */
const POSITIVOS = new Set([
  'si', 'sisi', 'claro', 'correcto', 'afirmativo', 'ok', 'okay', 'oka', 'vale',
  'funciona', 'funcionando', 'funciono', 'sirve', 'sirvio', 'quedo', 'quedamos',
  'solucionado', 'soluciono', 'arreglado', 'arreglo', 'resuelto', 'listo', 'lista',
  'perfecto', 'excelente', 'bien', 'bueno', 'buenisimo', 'genial', 'gracias',
  'muchisimas', 'agradezco', 'bacano', 'chevere', 'normal', 'estable',
]);

/**
 * Dicen que NO quedó. Ojo: 'no' está aquí Y en NEGADORES — como palabra suelta es la
 * respuesta negativa, y delante de un positivo lo anula.
 */
const NEGATIVOS = new Set([
  'no', 'nada', 'nunca', 'tampoco', 'negativo', 'sigue', 'siguen', 'sigo',
  'todavia', 'aun', 'igual', 'mismo', 'peor', 'lento', 'lenta',
  'intermitente', 'falla', 'fallando', 'fallo', 'malo', 'mal', 'pesimo',
  'apagado', 'muerto', 'caido', 'cae', 'regular', 'medias',
]);

/** Delante de un positivo, lo dan por negado. */
const NEGADORES = new Set(['no', 'nada', 'nunca', 'tampoco', 'sin']);

/**
 * Separadores de frase. Las comas y los puntos, y también los conectores de
 * contraste: "sí pero sigue lento" son dos afirmaciones y la que vale es la segunda.
 */
const SEPARADORES = /[,;.!?¿¡\n]+|\b(?:pero|aunque|sino|sin embargo|solo que|eso si)\b/g;

/** Minúsculas, sin tildes y sin nada que no sea letra, número o espacio. */
function normalizar(texto: string): string {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    // Marcas diacríticas combinantes: separa "quedó" en "quedo" + acento y lo quita.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n');
}

/** Veredicto de UNA frase. */
function frase(tokens: string[]): Veredicto {
  let positivos = 0;
  let negativos = 0;

  tokens.forEach((t, i) => {
    if (POSITIVOS.has(t)) {
      // ¿Viene negado? Se mira hacia atrás dentro de la MISMA frase: "no me funciona",
      // "sin señal todavía". La ventana es la frase completa y no las dos palabras
      // anteriores porque en español se cuelan pronombres y muletillas en medio
      // ("no me quedó", "no señor, no me sirve").
      const negado = tokens.slice(0, i).some((prev) => NEGADORES.has(prev));
      if (negado) return;
      positivos += 1;
      return;
    }
    if (NEGATIVOS.has(t)) negativos += 1;
  });

  if (positivos > 0) return 'si';
  if (negativos > 0) return 'no';
  return 'no-claro';
}

/**
 * Interpreta la respuesta del cliente. Devuelve 'no-claro' cuando no está diciendo ni
 * que sí ni que no: quien llama debe pasarle el mensaje al bot en vez de insistir.
 */
export function interpretarConfirmacion(texto: string): Veredicto {
  const limpio = normalizar(texto);
  if (!limpio.trim()) return 'no-claro';

  const frases = limpio
    .split(SEPARADORES)
    .map((f) => (f ?? '').replace(/[^a-z0-9\s]/g, ' ').trim())
    .filter(Boolean);

  // Manda la ÚLTIMA frase que diga algo. Lo que se escribe al final es la corrección
  // de lo anterior, no al revés.
  let veredicto: Veredicto = 'no-claro';
  for (const f of frases) {
    const v = frase(f.split(/\s+/).filter(Boolean));
    if (v !== 'no-claro') veredicto = v;
  }
  return veredicto;
}
