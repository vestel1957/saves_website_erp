/**
 * Pegamento de rutas: convierte un handler que DEVUELVE datos en uno de Express.
 *
 * En Nest un handler hacía `return this.servicio.algo()` y el framework serializaba
 * el valor y elegía el código de estado. Express no: hay que llamar a `res.json()` a
 * mano. `manejar()` mantiene el estilo "devuelve y ya" de los 616 handlers, para que
 * el port sea un cambio de forma y no una reescritura del cuerpo de cada uno.
 *
 * ------------------------------------------------------------------------------
 * DOS COMPORTAMIENTOS DE NEST QUE HAY QUE REPRODUCIR, O SE ROMPEN COSAS EN SILENCIO
 * ------------------------------------------------------------------------------
 *
 * 1) Código por defecto: Nest responde **201 en POST** y 200 en el resto. Express
 *    responde 200 siempre. Dejarlo pasar cambiaría el código de las ~211 rutas POST
 *    de la API sin que ningún test lo note.
 *
 * 2) Precedencia de área/permisos: en Nest, `@RequireArea` de MÉTODO sobreescribe al
 *    de CLASE (`getAllAndOverride`), mientras que `@UseGuards` de método se ACUMULA
 *    con el de clase. Por eso aquí NO hay herencia de área desde el router: cada ruta
 *    declara las áreas que de verdad le aplican (las que el manifiesto de contrato ya
 *    resolvió). Heredarlas y añadirlas sería un AND —más estricto que el original— y
 *    produciría 403 en rutas que hoy funcionan, que es justo el fallo que nadie ve
 *    hasta que un usuario llama por teléfono.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Middleware } from '../auth/middlewares';

/** Handler que devuelve el cuerpo de la respuesta (o nada). */
export type Handler<T = unknown> = (req: Request, res: Response) => T | Promise<T>;

/**
 * Envuelve un handler "que devuelve" en uno de Express.
 *
 * - Serializa el valor devuelto a JSON con el código que usaba Nest.
 * - Si el handler ya escribió en la respuesta (PDFs, Excel, streams: las 30 rutas
 *   que usaban `@Res`), no toca nada. Ahí el handler manda.
 * - Propaga cualquier throw al manejador global de errores. Sin este `.catch`,
 *   Express 4 se traga las promesas rechazadas y la petición queda colgada hasta el
 *   timeout en vez de responder 500.
 */
export function manejar<T>(handler: Handler<T>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res))
      .then((resultado) => {
        // El handler escribió él mismo (stream/descarga): no hay nada que serializar.
        if (res.headersSent) return;

        if (resultado === undefined || resultado === null) {
          // Nest devolvía 200/201 con cuerpo vacío, no un 204. Mantenerlo: hay
          // clientes que hacen `await res.json()` y un 204 los rompería.
          res.status(codigoPorDefecto(req)).end();
          return;
        }
        res.status(codigoPorDefecto(req)).json(resultado);
      })
      .catch(next);
  };
}

/** 201 en POST, 200 en el resto: el mismo criterio que aplicaba Nest. */
function codigoPorDefecto(req: Request): number {
  return req.method === 'POST' ? 201 : 200;
}

// No hay helper para fijar el código a mano: el manifiesto confirma que el proyecto
// no usa `@HttpCode` en ninguno de sus 616 endpoints. Si alguna ruta lo necesita,
// basta con que su handler llame a `res.status(...)` antes de devolver.

/**
 * Crea un router con middleware comunes a TODAS sus rutas.
 *
 * Sólo admite los que de verdad se acumulaban en Nest (autenticación, módulo de red).
 * Las áreas y los permisos se declaran ruta a ruta a propósito — ver la nota de
 * precedencia arriba.
 */
export function crearRouter(...comunes: Middleware[]): Router {
  const router = Router();
  anotarRegistros(router);
  if (comunes.length) router.use(...(comunes as RequestHandler[]));
  return router;
}

/**
 * Qué rutas declaró cada router, en el ORDEN en que las registró.
 *
 * Express guarda las suyas en `router.stack`, pero como expresiones regulares ya
 * compiladas: recuperar de ahí que el patrón era `/:id` es adivinar. Se anotan al
 * vuelo, que es exacto y no depende de internals del framework.
 *
 * Lo consume `rutas-tapadas.ts` para abortar el arranque si una ruta paramétrica
 * deja a otra literal inalcanzable.
 */
const REGISTROS = new WeakMap<Router, Array<{ metodo: string; ruta: string }>>();

const VERBOS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

function anotarRegistros(router: Router): void {
  const registradas: Array<{ metodo: string; ruta: string }> = [];
  REGISTROS.set(router, registradas);

  for (const verbo of VERBOS) {
    const original = router[verbo].bind(router) as (...args: unknown[]) => Router;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any)[verbo] = (ruta: unknown, ...resto: unknown[]) => {
      // Sólo interesan las rutas declaradas como cadena; nadie usa aquí las
      // formas con array ni con expresión regular.
      if (typeof ruta === 'string') registradas.push({ metodo: verbo, ruta });
      return original(ruta, ...resto);
    };
  }
}

/** Rutas que un router registró, en orden. Vacío si no salió de `crearRouter`. */
export function rutasDe(router: Router): Array<{ metodo: string; ruta: string }> {
  return REGISTROS.get(router) ?? [];
}
