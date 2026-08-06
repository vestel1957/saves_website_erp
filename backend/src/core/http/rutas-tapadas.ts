/**
 * Candado contra rutas tapadas.
 *
 * EL FALLO QUE ESTO IMPIDE
 * ------------------------
 * Express prueba las rutas EN EL ORDEN EN QUE SE REGISTRAN y responde con la
 * primera que encaja. Una ruta paramétrica acepta cualquier segmento, así que
 * registrar `/:id` antes que `/stats` deja `/stats` inalcanzable: la petición
 * entra en el manejador del detalle con `id = 'stats'` y sale un 404 "no
 * encontrado" perfectamente creíble.
 *
 * No lo detecta nada: compila, arranca, los tests del servicio pasan y el
 * endpoint responde — sólo que lo que responde es otra cosa. El síntoma aparece
 * lejos del culpable, en el navegador y semanas después.
 *
 * Pasó de verdad: al migrar de Nest a Express el generador de routers ordenaba
 * las rutas alfabéticamente, y como ':' (0x3A) va antes que cualquier letra,
 * `/:id` quedó por delante de TODOS los literales — 22 endpoints muertos en 10
 * módulos (`/tasks/assignees`, `/staff/areas`, `/orders/stats`…). Con Nest no
 * ocurría porque respetaba el orden de los decoradores del controlador.
 *
 * POR QUÉ AQUÍ Y NO EN EL GENERADOR
 * ---------------------------------
 * El generador ya ordena bien (`porEspecificidad`), pero eso arregla el caso de
 * ayer, no la clase de fallo: quedan routers escritos a mano, y sobre todo los
 * PREFIJOS COMPARTIDOS (`network`, `whatsapp`, `admin`, `profile` montan varios
 * routers bajo la misma raíz), donde el solapamiento cruza ficheros y ningún
 * generador lo ve. Esta comprobación mira el resultado final —lo que Express va
 * a montar de verdad— y por eso cubre las dos cosas.
 *
 * Aborta el arranque en vez de avisar: el veredicto no depende de los datos ni
 * del entorno, así que si arranca una vez arranca siempre. Un proceso que no
 * levanta se ve al instante; un endpoint muerto en silencio no se ve nunca.
 */
import type { Router } from 'express';
import { rutasDe } from './ruta';

export type Conflicto = {
  metodo: string;
  prefijo: string;
  /** La ruta literal que nunca se alcanza. */
  tapada: string;
  /** La ruta paramétrica registrada antes que se la come. */
  tapadora: string;
};

const esParametro = (segmento: string) => segmento.startsWith(':');

/**
 * ¿`patron` (registrado antes) se traga cualquier petición dirigida a `ruta`?
 *
 * Sólo cuenta cuando el patrón gana por ser MÁS GENÉRICO —tiene un parámetro
 * donde la otra tiene un literal—, que es el fallo real. Dos rutas idénticas o
 * un patrón más específico no se señalan: serían ruido.
 */
function tapa(patron: string, ruta: string): boolean {
  const a = patron.split('/');
  const b = ruta.split('/');
  if (a.length !== b.length) return false;

  let ganaPorGenerico = false;
  for (let i = 0; i < a.length; i++) {
    if (esParametro(a[i])) {
      // Un parámetro con patrón propio (`/:id(\\d+)`) no acepta cualquier cosa;
      // decidir si tapa exigiría evaluar su expresión regular, así que no se
      // señala. Preferible callar que dar un falso positivo que tumba el arranque.
      if (a[i].includes('(')) return false;
      if (!esParametro(b[i])) ganaPorGenerico = true;
      continue;
    }
    // Los comodines (`*`) suelen ser capturas a propósito; fuera del análisis.
    if (a[i].includes('*') || b[i].includes('*')) return false;
    if (a[i] !== b[i]) return false;
  }
  return ganaPorGenerico;
}

/**
 * Rutas inalcanzables entre las que se van a montar.
 *
 * Se agrupa por prefijo y se conserva el orden del índice: varios routers pueden
 * compartir prefijo y Express los prueba en ese orden, así que el conflicto puede
 * estar entre dos ficheros distintos.
 */
export function rutasTapadas(rutas: Array<{ prefijo: string; router: Router }>): Conflicto[] {
  const porPrefijo = new Map<string, Array<{ metodo: string; ruta: string }>>();
  for (const { prefijo, router } of rutas) {
    const acumulado = porPrefijo.get(prefijo) ?? [];
    acumulado.push(...rutasDe(router));
    porPrefijo.set(prefijo, acumulado);
  }

  const conflictos: Conflicto[] = [];
  for (const [prefijo, lista] of porPrefijo) {
    for (let i = 0; i < lista.length; i++) {
      for (let j = 0; j < i; j++) {
        const antes = lista[j];
        // `all` responde a cualquier verbo, así que también tapa.
        const mismoVerbo = antes.metodo === lista[i].metodo || antes.metodo === 'all';
        if (!mismoVerbo) continue;
        if (tapa(antes.ruta, lista[i].ruta)) {
          conflictos.push({
            metodo: lista[i].metodo.toUpperCase(),
            prefijo,
            tapada: lista[i].ruta,
            tapadora: antes.ruta,
          });
          break; // con la primera que la tapa basta
        }
      }
    }
  }
  return conflictos;
}

/** Mensaje de error con las rutas muertas y cómo arreglarlas. */
export function informeDeConflictos(conflictos: Conflicto[]): string {
  const filas = conflictos
    .map((c) => `  ${c.metodo} /api/${c.prefijo}${c.tapada}  ←  tapada por  ${c.tapadora}`)
    .join('\n');
  return [
    `${conflictos.length} ruta(s) inalcanzable(s): una ruta paramétrica se registra antes y se las come.`,
    filas,
    '',
    'Las rutas literales deben registrarse ANTES que las paramétricas.',
    'Los routers son ficheros GENERADOS: se arregla en scripts/generar-routers.ts',
    '(función `porEspecificidad`) y se vuelve a correr `npm run generar:routers`.',
    'Editar el .router.ts a mano se pierde en la siguiente generación.',
  ].join('\n');
}

/** Aborta el arranque si alguna ruta quedó inalcanzable. */
export function verificarRutasOAbortar(rutas: Array<{ prefijo: string; router: Router }>): void {
  const conflictos = rutasTapadas(rutas);
  if (conflictos.length) throw new Error(informeDeConflictos(conflictos));
}
