/**
 * Parte la respuesta del agente en los mensajes que mandaría una persona.
 *
 * Por qué existe: el motor devuelve UN texto y el transporte lo mandaba de un solo
 * golpe. Una consulta de reportes contesta con un muro de quince líneas que aparece
 * de la nada, y eso no se lee como una conversación de WhatsApp — se lee como un
 * volcado de sistema. Trocearlo (con su pausa y su "escribiendo…" entre medias) es
 * lo que da la sensación de que alguien está al otro lado.
 *
 * Reglas que NO se negocian, porque una respuesta partida mal es peor que un muro:
 *
 *   1. Nunca se corta a mitad de frase. Se corta entre párrafos, y si un párrafo no
 *      cabe, entre sus líneas; una frase suelta y sin final es ruido.
 *   2. Una lista NUNCA se separa de la línea que la presenta. "Los que más se salen
 *      de la mediana:" en un mensaje y las viñetas en otro deja el primero colgando.
 *   3. Los mensajes cortos no se tocan. Trocear un "Listo, ya quedó" en dos es
 *      exactamente el tic de bot que se está tratando de quitar.
 *   4. Hay un tope de trozos. Sin él, un reporte largo dispara ocho notificaciones
 *      seguidas al celular de un cliente, que es peor que el muro.
 *
 * Es una función pura a propósito: la decisión de qué se manda se puede probar sin
 * tocar la red (ver chat-chunks.spec.ts). El transporte solo la usa.
 */

/**
 * Por debajo de esto la respuesta viaja entera: partirla se siente artificial.
 *
 * 260 no es un número redondo por casualidad — es donde caen los avisos de dos
 * ideas ("estás suspendido" + el detalle de las facturas), que una persona sí
 * mandaría en dos mensajes. Subirlo a 300 los dejaba de una pieza.
 */
const MINIMO_PARA_PARTIR = 260;

/**
 * Tamaño al que se apunta por mensaje. No es un máximo duro: un bloque indivisible
 * manda por encima de esto antes que partirse a mitad.
 *
 * Tiene que ser MENOR que `MINIMO_PARA_PARTIR`, o se cuela un caso absurdo: un texto
 * que supera el umbral y aun así cabe entero en un trozo, así que "se parte" en uno
 * solo y no cambia nada. Además 240 es el tamaño real de un mensaje escrito por una
 * persona; con 400 salían dos parrafones que seguían leyéndose como un volcado.
 */
const OBJETIVO = 240;

/**
 * Máximo de mensajes por respuesta. Cuatro buzos seguidos ya es el límite de lo que
 * alguien tolera; a partir de ahí lo que sobra se acumula en el último.
 */
const MAX_TROZOS = 4;

/** ¿La línea es un ítem de lista? (viñeta, guion o numerada). */
const esItem = (linea: string): boolean => /^\s*(?:[•\-*]|\d+[.)])\s+/.test(linea);

/**
 * Un "bloque" es la unidad mínima que no se puede partir: un párrafo, o una lista
 * junto con la línea que la introduce.
 *
 * Se agrupa por línea y no solo por párrafo porque el agente escribe casi siempre
 * "intro:\n• uno\n• dos" SIN línea en blanco de por medio: si se partiera por
 * párrafos, eso sería un bloque enorme e indivisible; y si se partiera por líneas a
 * secas, la intro se iría sola en un mensaje.
 */
function bloques(texto: string): string[] {
  const salida: string[] = [];
  let actual: string[] = [];

  const cerrar = () => {
    const t = actual.join('\n').trim();
    if (t) salida.push(t);
    actual = [];
  };

  for (const linea of texto.split('\n')) {
    if (!linea.trim()) { cerrar(); continue; }

    // Un ítem se pega SIEMPRE a lo que venga arriba: o su intro, o el ítem anterior.
    if (esItem(linea)) { actual.push(linea); continue; }

    // Línea normal después de una lista: empieza bloque nuevo. Después de otra línea
    // normal, sigue en el mismo párrafo.
    if (actual.length && esItem(actual[actual.length - 1])) cerrar();
    actual.push(linea);
  }
  cerrar();
  return salida;
}

/**
 * Reparte los bloques en mensajes de ~OBJETIVO caracteres.
 *
 * Es voraz y no busca el reparto óptimo: lo que importa es que cada corte caiga en
 * una frontera real del texto, no que los mensajes queden parejos.
 */
function repartir(partes: string[]): string[] {
  const trozos: string[] = [];
  for (const bloque of partes) {
    const ultimo = trozos[trozos.length - 1];
    if (ultimo && ultimo.length + bloque.length + 2 <= OBJETIVO) {
      trozos[trozos.length - 1] = `${ultimo}\n\n${bloque}`;
    } else {
      trozos.push(bloque);
    }
  }
  return trozos;
}

/** Junta la cola en el último mensaje cuando se pasa del tope. */
function limitar(trozos: string[]): string[] {
  if (trozos.length <= MAX_TROZOS) return trozos;
  const cabeza = trozos.slice(0, MAX_TROZOS - 1);
  return [...cabeza, trozos.slice(MAX_TROZOS - 1).join('\n\n')];
}

/**
 * Pasa el markdown que suelta el modelo al formato que WhatsApp SÍ entiende.
 *
 * WhatsApp pone en negrita con UN asterisco (`*así*`); con dos, muestra los asteriscos
 * tal cual. El prompt le pide al modelo que no use markdown y aun así lo usa —lo tiene
 * demasiado metido—, así que el cliente recibía cosas como `**900 Megas + TV**`. Se
 * detectó mirando la salida real en el banco de pruebas.
 *
 * Se CONVIERTE en vez de borrarse: la negrita en una lista de planes ayuda a leer, y
 * además el motor usa `*SÍ*` en su pregunta de confirmación — borrar asteriscos a lo
 * bruto se la comería.
 */
export function aFormatoWhatsapp(texto: string): string {
  return String(texto ?? '')
    // **negrita** → *negrita* (no toca los asteriscos sueltos ni las viñetas).
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')
    // __subrayado__ de markdown → _cursiva_ de WhatsApp.
    .replace(/__(.+?)__/gs, '_$1_')
    // ### Título → negrita: WhatsApp no tiene encabezados.
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '*$1*');
}

/**
 * Texto del agente → mensajes a enviar, en orden. Siempre devuelve al menos uno, y
 * la unión de todos es el texto original (solo cambian los saltos entre bloques):
 * trocear no puede perder ni una línea de lo que el agente decidió decir.
 */
export function trocear(texto: string): string[] {
  const limpio = (texto ?? '').trim();
  if (!limpio) return [];
  if (limpio.length < MINIMO_PARA_PARTIR) return [limpio];

  const partes = bloques(limpio);
  if (partes.length <= 1) return [limpio];

  return limitar(repartir(partes));
}

/**
 * Cuánto esperar ANTES de mandar un trozo, para que se lea como alguien escribiendo.
 *
 * Crece con el largo del mensaje —un párrafo tarda más de teclear que una línea—
 * pero con techo: nadie va a mirar el "escribiendo…" cuatro segundos. El primer
 * trozo no pasa por aquí: quien preguntó ya esperó al modelo.
 */
export function pausaMs(trozo: string): number {
  return Math.min(2000, 500 + trozo.length * 3);
}
