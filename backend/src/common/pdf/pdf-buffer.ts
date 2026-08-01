import { Writable } from 'node:stream';
import type { Response } from 'express';

/**
 * Convierte cualquiera de los generadores `xPdf(res, datos)` en un Buffer.
 *
 * Todos los PDF del ERP nacieron para una respuesta HTTP: reciben el `Response` y le
 * hacen `doc.pipe(res)`. Pero el chatbot no responde a un navegador — tiene que
 * ADJUNTAR el archivo al chat, y para eso necesita los bytes en memoria.
 *
 * En vez de duplicar cada generador en una versión "…Buffer" (que es como se hizo con
 * la factura, y que obliga a mantener dos renders en paralelo), se les pasa un sumidero
 * en memoria: los generadores solo usan el `res` como stream de salida —nunca tocan
 * cabeceras ni `status`—, así que un `Writable` cualquiera les sirve. Un solo render,
 * un solo sitio donde cambia el diseño, y lo que llega por WhatsApp es byte por byte lo
 * mismo que se imprime desde la web.
 */
export function pdfToBuffer(render: (res: Response) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    // 'finish' = pdfkit llamó a `doc.end()` y el pipe cerró el sumidero.
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try {
      render(sink as unknown as Response);
    } catch (e) {
      // Un fallo síncrono al armar el documento (un dato nulo donde no se esperaba)
      // dejaría la promesa colgada para siempre: se rechaza aquí.
      reject(e);
    }
  });
}
