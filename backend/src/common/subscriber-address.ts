/**
 * La DIRECCIÓN del abonado, compuesta a partir de sus piezas.
 *
 * La dirección NO está en `Subscriber.addressLine`. Ese campo es
 * `customers.dirsuscriptor` del legacy y está prácticamente vacío —211 filas de
 * 21.867— y las que trae son basura de captura: '0', 'example.png', un pedazo de
 * coordenada ('5.338126,'), la misma 'Carrera 70 # 52-37 Barrio Normandia'
 * repetida en clientes que no tienen nada que ver, y direcciones que CONTRADICEN
 * a las piezas (el abonado 56029 dice 'calle 14#13-26' y sus piezas dicen
 * Carrera 14 # 21-5). Fiarse de él es mandar al técnico a otra casa.
 *
 * La dirección de verdad está partida en `Subscriber.nomenclature`, el JSON con
 * las mismas casillas que captura el formulario del legacy (y el asistente de
 * alta de aquí): 21.722 de 21.867 abonados la tienen. Esta función las junta en
 * el orden en que se leen en Colombia:
 *
 *     Calle 33 A # 44 E - 17    ·    Carrera 7 # 11 - 2 Torre 3 Apartamento 401
 *
 * `addressLine` queda solo de último recurso, para el puñado de abonados sin
 * piezas (4 del legacy más los que se creen aquí escribiendo solo ese campo).
 */

/**
 * Se recibe como `unknown` porque en la base es una columna Json: Prisma la
 * tipa como `JsonValue`, que también puede venir texto, número o lista. Se
 * comprueba antes de leerle casillas en vez de forzar el tipo.
 */
type Nomenclatura = unknown;

const casillas = (v: Nomenclatura): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Texto limpio de una casilla; '0' es como el legacy deja "vacío" en varias. */
function pieza(nom: Record<string, unknown>, clave: string): string {
  const v = nom[clave];
  if (v == null) return '';
  const s = String(v).trim();
  return s === '' || s === '0' ? '' : s;
}

export function direccionDe(nomenclature: Nomenclatura, addressLine?: string | null): string | null {
  const nom = casillas(nomenclature);
  const p = (k: string) => pieza(nom, k);

  // "Calle 33 A": la vía, su número y la letra que lo acompaña.
  const via = [p('nomenclatura'), p('numero1'), p('adicionauno')].filter(Boolean).join(' ');
  // "# 44 E - 17": la placa. El '#' y el guion son la puntuación de un cruce de
  // vías y solo tienen sentido si están las DOS mitades. Cuando falta la primera
  // —569 abonados a los que se les capturó 'Lote 188' o 'Casa 3' en la casilla
  // del final— se escribe lo que hay tal cual: 'Manzana # Lote - 188' no es una
  // dirección, 'Manzana Lote 188' sí.
  const numero2 = p('numero2');
  const numero3 = p('numero3');
  const adicional2 = p('adicional2');
  const cruce = numero2 ? `# ${[numero2, adicional2].filter(Boolean).join(' ')}` : '';
  const placa = !numero3 ? ''
    : cruce ? `- ${numero3}`
      : [adicional2, numero3].filter(Boolean).join(' ');
  // "Torre 3", "Apartamento 401": van con su número o no van (una 'Manzana' suelta
  // no le dice nada a nadie).
  const div1 = p('divnum1') ? [p('divicion') || 'Torre', p('divnum1')].join(' ') : '';
  const div2 = p('divnum2') ? [p('divicion2') || 'Casa', p('divnum2')].join(' ') : '';

  // Una vía sin ningún número es solo la palabra 'Calle': no es una dirección y
  // estorba delante de lo que sí lo es.
  const cabeza = p('numero1') || cruce || placa ? via : '';
  const armada = [cabeza, cruce, placa, div1, div2].filter(Boolean).join(' ').trim();
  if (armada) return armada;

  const suelta = (addressLine ?? '').trim();
  return suelta && suelta !== '0' ? suelta : null;
}

/**
 * La REFERENCIA para llegar ('Frente a la Hogareña', 'PISO 1', 'esquina'), que
 * el legacy guarda aparte y 4.915 abonados tienen. No es la dirección: es la
 * pista que se le da al técnico cuando la placa no basta.
 */
export function referenciaDe(nomenclature: Nomenclatura): string | null {
  const nom = casillas(nomenclature);
  const ref = pieza(nom, 'referencia');
  const res = pieza(nom, 'residencia');
  return [res, ref].filter(Boolean).join(' · ') || null;
}

/**
 * Las casillas en que está partida la dirección, tal cual las nombra el legacy
 * (`customers.nomenclatura`, `numero1`…) y las captura el formulario de alta.
 *
 * Están aquí y no en el formulario porque ya son la fuente de dos sitios que
 * escriben dirección: el alta del cliente y la orden de TRASLADO, que guarda a
 * dónde se muda. Dos listas separadas acabarían perdiendo una casilla por el
 * camino, y una casilla perdida es un técnico llamando a la puerta de al lado.
 */
export const CASILLAS_DIRECCION = [
  'nomenclatura', 'numero1', 'adicionauno', 'numero2', 'adicional2', 'numero3',
  'residencia', 'referencia', 'divicion', 'divnum1', 'divicion2', 'divnum2',
] as const;

/**
 * Deja un objeto de dirección con SOLO esas casillas, en texto y recortadas.
 *
 * Lo que llega por HTTP es un JSON libre: sin esta puerta, `Subscriber.nomenclature`
 * acabaría guardando lo que quiera mandar quien llame, y de ahí sale el writeback
 * que escribe columnas `varchar` del MySQL del legacy. El tope de 50 es el de las
 * columnas más largas de esa tabla.
 */
export function nomenclaturaLimpia(v: Nomenclatura): Record<string, string | null> {
  const nom = casillas(v);
  const limpia: Record<string, string | null> = {};
  for (const k of CASILLAS_DIRECCION) {
    const bruto = nom[k];
    const s = bruto == null ? '' : String(bruto).trim().slice(0, 50);
    limpia[k] = s || null;
  }
  return limpia;
}

/**
 * Dónde vive el abonado en una línea: "Centro · Yopal".
 *
 * La sede se nombra SOLO cuando difiere del municipio: cada sede se llama como su
 * municipio y coinciden en el 99,7% de los abonados, así que ponerlas siempre deja
 * "Centro · Yopal · Yopal". Los 44 clientes atendidos desde otra sede sí la ven, que
 * es justo cuando enterarse importa. Comparación sin tildes ni mayúsculas y con
 * `trim`: el catálogo del legacy trae nombres con espacios de sobra ("Popayán ").
 */
export function ubicacionDe(s: {
  neighborhood?: string | null; city?: string | null; branch?: string | null;
}): string {
  const norm = (v: string) => v.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const mismoSitio = !!s.city && !!s.branch && norm(s.city) === norm(s.branch);
  return [s.neighborhood, s.city, mismoSitio ? null : s.branch].filter(Boolean).join(' · ');
}
