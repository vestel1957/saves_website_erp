/**
 * Límite global de peticiones por IP (sustituye a `ThrottlerModule` + `ThrottlerGuard`).
 *
 * El tope es GENEROSO a propósito: una oficina entera sale por la misma IP pública,
 * así que un límite estrecho castigaría a usuarios legítimos. Aun así corta en seco
 * el escaneo automatizado y el abuso de los endpoints caros (PDFs, exportaciones a
 * Excel, masivas). El login tiene además su propio freno, mucho más estricto.
 *
 * Se implementa a mano y no con `express-rate-limit` por dos razones: no añade una
 * dependencia nueva en una migración que ya mueve bastante, y el proyecto ya usa
 * este mismo patrón de ventana deslizante en memoria en el freno del login y en la
 * API pública por clave. Tres implementaciones distintas de lo mismo serían peor.
 *
 * El estado vive en el proceso. Con varias instancias cada una lleva su cuenta, que
 * es exactamente lo que hacía el ThrottlerModule con su almacenamiento por defecto.
 */
import type { RequestHandler } from 'express';

export interface OpcionesLimitador {
  /** Peticiones permitidas por ventana. */
  limite?: number;
  /** Tamaño de la ventana en milisegundos. */
  ventanaMs?: number;
}

export function crearLimitador(opciones: OpcionesLimitador = {}): RequestHandler {
  const limite = opciones.limite ?? 600;
  const ventanaMs = opciones.ventanaMs ?? 60_000;
  const golpes = new Map<string, number[]>();

  // Barrido periódico de IPs inactivas. Sin esto el mapa crece con cada IP que haya
  // pasado por la API y nunca se vacía: en un proceso que vive semanas, eso es una
  // fuga de memoria lenta. `unref()` para que este temporizador no impida que el
  // proceso termine cuando pm2 lo reinicia.
  const barrido = setInterval(() => {
    const ahora = Date.now();
    for (const [ip, marcas] of golpes) {
      if (marcas.every((t) => ahora - t >= ventanaMs)) golpes.delete(ip);
    }
  }, ventanaMs);
  barrido.unref();

  return (req, res, next) => {
    const clave = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const ahora = Date.now();
    const recientes = (golpes.get(clave) ?? []).filter((t) => ahora - t < ventanaMs);

    if (recientes.length >= limite) {
      // Cabeceras estándar para que un cliente educado sepa cuándo reintentar.
      res.setHeader('Retry-After', Math.ceil(ventanaMs / 1000));
      res.status(429).json({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Demasiadas peticiones. Espera un momento e inténtalo de nuevo.',
        path: req.originalUrl ?? req.url,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    recientes.push(ahora);
    golpes.set(clave, recientes);
    next();
  };
}
