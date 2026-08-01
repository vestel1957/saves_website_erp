import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_ROOT, guardarNotaDeVoz, rutaDeNotaDeVoz } from './whatsapp-audio.store';

/**
 * El almacén de notas de voz. Lo que se fija aquí es lo que hace que el reproductor
 * de la bandeja no muestre nunca un botón que no suena: qué se guarda, con qué nombre,
 * y qué NO se sirve.
 */

/** Cabecera real de un OGG ('OggS' + versión + flags) para no probar con basura. */
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.from([0x00, 0x02]), Buffer.alloc(20)]);

describe('guardarNotaDeVoz', () => {
  const guardados: string[] = [];
  afterAll(() => {
    for (const n of guardados) rmSync(join(AUDIO_ROOT, n), { force: true });
  });

  it('guarda el binario y devuelve un nombre RELATIVO (no la ruta de despliegue)', () => {
    const r = guardarNotaDeVoz({ data: OGG, mimetype: 'audio/ogg; codecs=opus' })!;
    guardados.push(r.path);

    expect(r.path).toMatch(/^[0-9a-f-]{36}\.ogg$/);
    // Nada de rutas absolutas en la BD: al mover el proyecto, el histórico se caería.
    expect(r.path).not.toContain('/');
    // El MIME se normaliza sin los parámetros, que es lo que se sirve como Content-Type.
    expect(r.mime).toBe('audio/ogg');
    expect(readFileSync(join(AUDIO_ROOT, r.path))).toEqual(OGG);
  });

  it('la extensión sale del MIME validado, nunca de lo que venga del otro lado', () => {
    const mp3 = guardarNotaDeVoz({ data: OGG, mimetype: 'audio/mpeg' })!;
    guardados.push(mp3.path);
    expect(mp3.path.endsWith('.mp3')).toBe(true);
  });

  it('un tipo que no es de audio no se guarda', () => {
    // El caso que importa: si esto pasara, quedaría un archivo servible por la API con
    // contenido de un tercero (ver el porqué en `common/uploads.ts`).
    expect(guardarNotaDeVoz({ data: OGG, mimetype: 'text/html' })).toBeNull();
    expect(guardarNotaDeVoz({ data: OGG, mimetype: 'application/pdf' })).toBeNull();
    expect(guardarNotaDeVoz({ data: OGG, mimetype: undefined })).toBeNull();
  });

  it('un audio vacío no deja un archivo de 0 bytes', () => {
    expect(guardarNotaDeVoz({ data: Buffer.alloc(0), mimetype: 'audio/ogg' })).toBeNull();
  });
});

describe('rutaDeNotaDeVoz', () => {
  it('resuelve lo que se acaba de guardar', () => {
    const r = guardarNotaDeVoz({ data: OGG, mimetype: 'audio/ogg' })!;
    try {
      const ruta = rutaDeNotaDeVoz(r.path);
      expect(ruta).not.toBeNull();
      expect(existsSync(ruta!)).toBe(true);
    } finally {
      rmSync(join(AUDIO_ROOT, r.path), { force: true });
    }
  });

  it('no sirve nada que se salga de la carpeta', () => {
    for (const malo of ['../../.env', '../.env', '/etc/passwd', 'a/b.ogg', '..%2F.env', '']) {
      expect(rutaDeNotaDeVoz(malo)).toBeNull();
    }
  });

  it('un archivo que ya no está devuelve null en vez de una ruta muerta', () => {
    // Es el caso de una nota purgada del disco: la bandeja debe decirlo, no romperse.
    expect(rutaDeNotaDeVoz('00000000-0000-4000-8000-000000000000.ogg')).toBeNull();
  });
});
