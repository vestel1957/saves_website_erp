/**
 * Excepciones HTTP propias, sustitutas de las de `@nestjs/common`.
 *
 * Replican DELIBERADAMENTE la firma de Nest (`getStatus()`, `getResponse()`, y el
 * constructor que acepta string u objeto). No es nostalgia: hay 802 `throw` de estas
 * clases repartidos por 227 ficheros de servicio. Con la misma firma, migrar todos
 * ellos es reescribir la línea del `import` —mecánico y verificable— en vez de
 * reescribir 802 sentencias a mano, que es donde se colarían los errores.
 *
 * La forma del cuerpo que ve el frontend tampoco cambia: la fija el manejador de
 * errores, que lee `getStatus()`/`getResponse()` igual que hacía el filtro de Nest.
 */

/** Códigos HTTP usados en el proyecto (sustituye a `HttpStatus` de Nest). */
export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/** Texto canónico de cada código, para el campo `error` del cuerpo. */
const TEXTO: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function textoDeEstado(status: number): string {
  return TEXTO[status] ?? 'Error';
}

/** Igual que Nest: un mensaje suelto o un objeto con campos. Se admite `object` y no
 *  sólo `Record` porque el proyecto también pasa arrays de mensajes (los que produce
 *  la validación), y acotarlo más obligaría a castear en cada sitio que ya funciona. */
type CuerpoError = string | object;

/**
 * Base de todas las excepciones HTTP. Equivalente a `HttpException` de Nest.
 *
 * El cuerpo puede ser un string (mensaje suelto) o un objeto, que es como el
 * proyecto adjunta campos accionables al error —p.ej. `{ message, code: 'GEOFENCE',
 * distancia }`— para que el frontend distinga un error de negocio de un fallo
 * cualquiera sin comparar textos.
 */
export class HttpException extends Error {
  constructor(
    private readonly cuerpo: CuerpoError,
    private readonly status: number,
  ) {
    super(
      typeof cuerpo === 'string'
        ? cuerpo
        : ((cuerpo as { message?: string })?.message ?? 'Error'),
    );
    this.name = new.target.name;
    // Sin esto, `instanceof` falla al extender Error compilando a ES5/ES2015.
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, new.target);
  }

  getStatus(): number {
    return this.status;
  }

  getResponse(): CuerpoError {
    return this.cuerpo;
  }
}

/**
 * Normaliza el cuerpo igual que hacía `HttpException.createBody` de Nest.
 *
 * No es un detalle cosmético: Nest ENVUELVE los mensajes sueltos y las LISTAS de
 * mensajes en `{ statusCode, message, error }`, y deja pasar los objetos tal cual.
 * Sin esto, un `new BadRequestException(['el email no es válido'])` —la forma en que
 * viaja una lista de errores de validación— salía como cuerpo crudo y el manejador
 * no encontraba `message`: el usuario veía "Error" en vez de qué campo falla.
 * Lo detectó el test heredado del filtro anterior.
 */
function crearCuerpo(cuerpo: CuerpoError, error: string, status: number): CuerpoError {
  if (typeof cuerpo === 'string' || Array.isArray(cuerpo)) {
    return { statusCode: status, message: cuerpo, error };
  }
  return cuerpo;
}

// Cada excepción se declara como una clase con nombre y no con una fábrica. Es más
// texto, pero una fábrica devuelve clases ANÓNIMAS: TypeScript no puede emitir sus
// declaraciones (TS4094) y obliga además a redeclarar cada tipo a mano. Escritas así
// se leen, se navegan con "ir a la definición" y funcionan como tipo y como valor.

export class BadRequestException extends HttpException {
  constructor(cuerpo: CuerpoError = 'Solicitud inválida.') {
    super(crearCuerpo(cuerpo, 'Bad Request', 400), 400);
  }
}

export class UnauthorizedException extends HttpException {
  constructor(cuerpo: CuerpoError = 'No autenticado.') {
    super(crearCuerpo(cuerpo, 'Unauthorized', 401), 401);
  }
}

export class ForbiddenException extends HttpException {
  constructor(cuerpo: CuerpoError = 'No autorizado.') {
    super(crearCuerpo(cuerpo, 'Forbidden', 403), 403);
  }
}

export class NotFoundException extends HttpException {
  constructor(cuerpo: CuerpoError = 'No encontrado.') {
    super(crearCuerpo(cuerpo, 'Not Found', 404), 404);
  }
}

export class ConflictException extends HttpException {
  constructor(cuerpo: CuerpoError = 'Conflicto.') {
    super(crearCuerpo(cuerpo, 'Conflict', 409), 409);
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(cuerpo: CuerpoError = 'El contenido es demasiado grande.') {
    super(crearCuerpo(cuerpo, 'Payload Too Large', 413), 413);
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(cuerpo: CuerpoError = 'No se pudo procesar.') {
    super(crearCuerpo(cuerpo, 'Unprocessable Entity', 422), 422);
  }
}

export class InternalServerErrorException extends HttpException {
  constructor(cuerpo: CuerpoError = 'Error interno del servidor.') {
    super(crearCuerpo(cuerpo, 'Internal Server Error', 500), 500);
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(cuerpo: CuerpoError = 'Servicio no disponible.') {
    super(crearCuerpo(cuerpo, 'Service Unavailable', 503), 503);
  }
}
