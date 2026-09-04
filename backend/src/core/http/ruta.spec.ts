import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import express from 'express';
import { manejar } from './ruta';

/**
 * El port a Express rompió TODOS los ficheros que el ERP genera al vuelo —los 9 PDF,
 * las fotos, los adjuntos— y lo hizo sin un solo error en el log: `manejar` daba por
 * vacío al handler que aún estaba arrancando el stream y cerraba la respuesta. El
 * cliente recibía 200, `Content-Type: application/pdf` y cero bytes.
 *
 * Por eso estos casos no comprueban códigos ni cabeceras sino BYTES: es lo único que
 * distingue un PDF que abre de uno que no, y era justo lo que nadie estaba mirando.
 */

/** Levanta la app en un puerto libre y devuelve cómo pedirle una ruta. */
async function servidor(app: express.Express) {
  const srv: Server = createServer(app);
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const { port } = srv.address() as { port: number };
  return {
    async get(ruta: string) {
      const r = await fetch(`http://127.0.0.1:${port}${ruta}`);
      return { status: r.status, tipo: r.headers.get('content-type'), cuerpo: Buffer.from(await r.arrayBuffer()) };
    },
    cerrar: () => new Promise<void>((ok) => srv.close(() => ok())),
  };
}

describe('manejar: handlers que se hacen cargo de la respuesta', () => {
  it('deja pasar los bytes de un stream pipeado en un tick posterior (PDFKit)', async () => {
    const app = express();
    app.get(
      '/pdf',
      manejar((_req, res) => {
        // Mismo patrón que `invoicePdf`: se preparan cabeceras, se pipea y se
        // devuelve void. Los bytes salen después, como hace PDFKit.
        res.setHeader('Content-Type', 'application/pdf');
        const doc = new PassThrough();
        doc.pipe(res);
        setTimeout(() => {
          doc.write('%PDF-1.7 contenido');
          doc.end();
        }, 10);
      }),
    );
    const s = await servidor(app);
    try {
      const r = await s.get('/pdf');
      expect(r.status).toBe(200);
      expect(r.tipo).toBe('application/pdf');
      expect(r.cuerpo.toString()).toBe('%PDF-1.7 contenido');
    } finally {
      await s.cerrar();
    }
  });

  it('no corta un `res.sendFile` (hace stat antes de escribir: la petición se colgaba)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ruta-spec-'));
    const fichero = join(dir, 'foto.txt');
    writeFileSync(fichero, 'los bytes del fichero');

    const app = express();
    app.get(
      '/foto',
      manejar((_req, res) => {
        res.sendFile(fichero);
      }),
    );
    const s = await servidor(app);
    try {
      const r = await s.get('/foto');
      expect(r.status).toBe(200);
      expect(r.cuerpo.toString()).toBe('los bytes del fichero');
    } finally {
      await s.cerrar();
    }
  });

  it('sigue cerrando con cuerpo vacío el handler que de verdad no devuelve nada', async () => {
    const app = express();
    app.get('/nada', manejar(() => undefined));
    app.post('/crear', manejar(() => undefined));
    const s = await servidor(app);
    try {
      const r = await s.get('/nada');
      expect(r.status).toBe(200);
      expect(r.cuerpo.length).toBe(0);
    } finally {
      await s.cerrar();
    }
  });

  it('sigue serializando a JSON el valor devuelto', async () => {
    const app = express();
    app.get('/datos', manejar(() => ({ ok: true })));
    const s = await servidor(app);
    try {
      const r = await s.get('/datos');
      expect(r.status).toBe(200);
      expect(JSON.parse(r.cuerpo.toString())).toEqual({ ok: true });
    } finally {
      await s.cerrar();
    }
  });
});
