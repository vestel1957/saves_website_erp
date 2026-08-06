/**
 * Validación de entrada (sustituye al `ValidationPipe` global de Nest).
 *
 * Los 30 DTO con sus ~2.000 decoradores de `class-validator` NO se tocan:
 * `class-validator` y `class-transformer` son librerías independientes, no parte de
 * Nest. Lo único que se reimplementa es el pegamento que los invocaba.
 *
 * Reproduce exactamente la configuración que había en `main.ts`:
 *   whitelist: true                          -> descarta propiedades no declaradas
 *   transform: true                          -> instancia la clase del DTO
 *   enableImplicitConversion: true           -> "5" -> 5, "true" -> true según el tipo
 *
 * Y reproduce la FORMA del error 400 de Nest —`message` como array de strings— que
 * es la que el frontend ya sabe pintar campo a campo. Devolver un string suelto
 * habría dejado los formularios sin señalar qué campo falla.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { BadRequestException } from './errores';

/** Constructor de una clase DTO. */
type Clase<T> = new (...args: any[]) => T;

/** Aplana los errores anidados (@ValidateNested) a la lista de mensajes de Nest. */
function mensajes(errores: ValidationError[]): string[] {
  const salida: string[] = [];
  const recorrer = (lista: ValidationError[]) => {
    for (const e of lista) {
      if (e.constraints) salida.push(...Object.values(e.constraints));
      if (e.children?.length) recorrer(e.children);
    }
  };
  recorrer(errores);
  return salida;
}

/**
 * Valida y transforma un objeto plano contra una clase DTO.
 * Lanza 400 con la lista de mensajes si no cumple.
 *
 *   const dto = validar(CreatePlanDto, req.body);
 */
export function validar<T extends object>(clase: Clase<T>, datos: unknown): T {
  // `??  {}`: un POST sin cuerpo llega como undefined y `plainToInstance` lo
  // propaga tal cual, con lo que la validación pasaría de largo en vez de exigir
  // los campos obligatorios.
  const instancia = plainToInstance(clase, datos ?? {}, {
    enableImplicitConversion: true,
    // Descarta lo que el DTO no declara, igual que `whitelist`. Es lo que impide
    // que un cliente cuele campos extra que luego un `...dto` metería en Prisma.
    excludeExtraneousValues: false,
  });

  const errores = validateSync(instancia as object, {
    whitelist: true,
    forbidNonWhitelisted: false,
    // Sin esto, los @ValidateNested no se recorren y un objeto anidado inválido
    // pasaría entero.
    validationError: { target: false, value: false },
  });

  if (errores.length) {
    throw new BadRequestException({
      message: mensajes(errores),
      error: 'Bad Request',
      statusCode: 400,
    });
  }

  // No hace falta podar a mano: `whitelist: true` hace que `validateSync` BORRE
  // in-place las propiedades sin decorador. Comprobado contra las versiones que usa
  // el proyecto: {nombre, edad:"42", esAdmin, rol} queda en {nombre, edad:42}.
  // Es la barrera contra la asignación masiva —que un cliente cuele `rol:'admin'`
  // y un `...dto` lo lleve hasta Prisma—, así que si algún día se toca esta opción,
  // hay que sustituirla por una poda explícita.
  return instancia;
}

/**
 * Valida los parámetros de query contra un DTO.
 * Idéntico a `validar`, pero se nombra aparte porque en la query TODO llega como
 * string y la conversión implícita es la que hace el trabajo (`?page=2` -> 2).
 */
export function validarQuery<T extends object>(clase: Clase<T>, datos: unknown): T {
  return validar(clase, datos);
}

/**
 * Convierte un valor de query a entero acotado, para las rutas que no tienen DTO.
 * Devuelve `porDefecto` si viene vacío o no es número.
 */
export function entero(
  valor: unknown,
  porDefecto: number,
  opciones: { min?: number; max?: number } = {},
): number {
  const n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto;
  const entero = Math.trunc(n);
  if (opciones.min !== undefined && entero < opciones.min) return opciones.min;
  if (opciones.max !== undefined && entero > opciones.max) return opciones.max;
  return entero;
}

/** `?activeOnly=true` -> true. Nest lo hacía con la conversión implícita. */
export function booleano(valor: unknown): boolean {
  return valor === true || valor === 'true' || valor === '1';
}
