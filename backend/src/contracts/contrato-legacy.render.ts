import { InternalServerErrorException } from '../core/http/errores';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Puente al renderizador del contrato: la vista y el motor del legacy (mPDF).
 *
 * El contrato y su anexo NO se redibujan aquí. Se pintan con las mismas vistas
 * que usa el legacy —copiadas literalmente en `contrato-php/vistas/`— y con mPDF
 * 8.1.6, la misma librería y los mismos márgenes de `Customers::printpdf`. Este
 * archivo solo arma el sobre: escribe los datos en un JSON temporal, llama a PHP
 * y devuelve los bytes del PDF.
 *
 * Sí, es un proceso aparte por documento. Un contrato se imprime unas pocas veces
 * al día; la alternativa —redibujar a mano un documento legal de cuatro páginas en
 * otra librería— produce otro papel, que es justo lo que no se quiere.
 */

/** Raíz del proyecto PHP (vistas + vendor + render.php). */
const PHP_DIR = resolve(process.cwd(), 'contrato-php');
const PHP_BIN = process.env.PHP_BIN || 'php';
const TIMEOUT_MS = 30_000;

export type VistaLegacy = 'contrato' | 'anexo';

/** Payload con la forma de fila que esperan las vistas del legacy. */
export type DatosContratoLegacy = Record<string, unknown>;

function exigirEntorno() {
  if (!existsSync(join(PHP_DIR, 'vendor', 'autoload.php'))) {
    throw new InternalServerErrorException(
      'Falta preparar el renderizador del contrato: ejecuta `composer install` en backend/contrato-php.',
    );
  }
}

export async function renderContratoLegacy(
  vista: VistaLegacy,
  datos: DatosContratoLegacy,
): Promise<Buffer> {
  exigirEntorno();
  const dir = await mkdtemp(join(tmpdir(), 'contrato-'));
  const jsonPath = join(dir, 'datos.json');
  const pdfPath = join(dir, 'salida.pdf');

  try {
    await writeFile(jsonPath, JSON.stringify(datos), 'utf8');

    await new Promise<void>((ok, fail) => {
      const php = spawn(PHP_BIN, [join(PHP_DIR, 'render.php'), vista, jsonPath, pdfPath], {
        cwd: PHP_DIR,
        timeout: TIMEOUT_MS,
      });
      let err = '';
      php.stderr.on('data', (d) => { err += String(d); });
      php.on('error', (e) => fail(new InternalServerErrorException(
        `No se pudo ejecutar PHP para generar el contrato (${e.message}). Instálalo o define PHP_BIN.`,
      )));
      php.on('close', (code) => {
        if (code === 0) return ok();
        fail(new InternalServerErrorException(
          `El contrato no se pudo generar (php salió con ${code}). ${err.slice(0, 300)}`,
        ));
      });
    });

    return await readFile(pdfPath);
  } finally {
    // El PDF ya está en memoria; el temporal no tiene por qué sobrevivir a la
    // petición (lleva datos personales del abonado).
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
