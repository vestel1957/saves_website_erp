import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIND_CARTA_RETIRO,
  KIND_VIVIENDA,
  KINDS_ARCHIVO_ABONADO,
  TIPOS_ARCHIVO_ABONADO,
  etiquetaTipoArchivo,
  normalizarTipoArchivo,
} from './subscriber-file-kinds';

/**
 * TIPO DE DOCUMENTO de los adjuntos del cliente.
 *
 * Lo que se fija aquí es lo que se rompe callado si alguien toca el catálogo:
 * la ventanilla elige el tipo en un desplegable del frontend y el backend lo
 * valida contra ESTA lista, así que una lista se puede ir de la otra y el usuario
 * se lleva un 400 al subir un papel perfectamente normal.
 */
describe('tipos de archivo del abonado', () => {
  it('deja pasar sólo los tipos del catálogo', () => {
    expect(normalizarTipoArchivo('SOLICITUD')).toBe('SOLICITUD');
    // Se acepta en minúscula porque el tipo viaja como campo de formulario.
    expect(normalizarTipoArchivo(' suspension ')).toBe('SUSPENSION');
    expect(() => normalizarTipoArchivo('CARTA')).toThrow(/no válido/i);
  });

  it('sin tipo = adjunto sin clasificar, no un error', () => {
    // Los 14.420 archivos que bajaron del legacy están así, y la API tiene que
    // poder seguir recibiendo una subida sin tipo (p. ej. desde el bot).
    expect(normalizarTipoArchivo(undefined)).toBeNull();
    expect(normalizarTipoArchivo('')).toBeNull();
  });

  it('mantiene las dos marcas que NO son sólo una etiqueta', () => {
    // `CARTA_RETIRO` es un requisito del paz y salvo (`SubscribersService.statement`)
    // y `VIVIENDA` es la foto de la portada de la ficha: si se les cambia el valor,
    // los archivos ya guardados dejan de encontrarse.
    expect(KIND_CARTA_RETIRO).toBe('CARTA_RETIRO');
    expect(KIND_VIVIENDA).toBe('VIVIENDA');
    expect(KINDS_ARCHIVO_ABONADO.has(KIND_CARTA_RETIRO)).toBe(true);
    expect(KINDS_ARCHIVO_ABONADO.has(KIND_VIVIENDA)).toBe(true);
  });

  it('tiene etiqueta legible para cada tipo', () => {
    expect(etiquetaTipoArchivo(KIND_CARTA_RETIRO)).toBe('Carta de retiro');
    expect(etiquetaTipoArchivo(null)).toBeNull();
  });

  it('el desplegable del frontend ofrece exactamente estos tipos', () => {
    // El catálogo está duplicado en `frontend/src/lib/subscribers.ts` porque la
    // pantalla no puede importar del backend. Esta prueba es el candado: si las
    // dos listas se separan, subir el tipo nuevo devolvería 400.
    const fuente = readFileSync(join(__dirname, '../../../frontend/src/lib/subscribers.ts'), 'utf8');
    const bloque = fuente.split('SUB_FILE_KIND_OPTS')[1]?.split('];')[0] ?? '';
    const delFrontend = [...bloque.matchAll(/value: "([A-Z_]+)"/g)].map((m) => m[1]);
    expect(delFrontend).toEqual(TIPOS_ARCHIVO_ABONADO.map((t) => t.kind));
  });
});
