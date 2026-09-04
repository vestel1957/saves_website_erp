import type { Response } from 'express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '../core/http/errores';
import { PaymentImportsService } from './payment-imports.service';
import { AuthUser } from '../auth/current-user.decorator';
import { enviarAdjuntoSeguro } from '../common/uploads';

/** Carpeta donde se guarda el .xlsx original de cada cargue. */
export const PAYMENT_IMPORTS_ROOT = join(process.cwd(), 'uploads', 'payment-imports');

/**
 * Cargue masivo de pagos externos — migrado de saves-vestel
 * `Transactions::cargar_desde_excel`.
 *
 * Sólo administración (2026-08-03). Su pantalla (`/tesoreria/importar-pagos`) ya se
 * le había quitado a la cajera el 2026-07-29 —aplica cientos de pagos de golpe y
 * dispara reconexiones—, pero la API seguía abierta al área caja: quitar la pantalla
 * no cierra la ruta.
 */
export class PaymentImportsController {
  constructor(private readonly imports: PaymentImportsService) {}

  list() { return this.imports.list(); }
  detail(id: string) { return this.imports.detail(id); }

  async upload(file: any, date: string | undefined, mode: string | undefined, user: AuthUser) {
    if (!file?.buffer && !file?.path) throw new BadRequestException('Sube un archivo .xlsx en el campo "file".');
    const buffer: Buffer = file.buffer ?? readFileSync(file.path);
    return this.imports.upload(buffer, file.originalname ?? 'cargue.xlsx', date, user, {
      mode: mode === 'plan' ? 'plan' : 'pagos',
      storedFile: file.filename ?? null,
    });
  }

  /** `limit` = tamaño de la tanda; sin él se procesa el lote entero. */
  process(id: string, limit: string | undefined, user: AuthUser) {
    return this.imports.process(id, user, limit == null || limit === '' ? undefined : Number(limit));
  }

  retry(id: string) { return this.imports.retry(id); }
  remove(id: string) { return this.imports.remove(id); }

  /** Descarga del .xlsx tal como se subió (el enlace del "Nombre" en el legacy). */
  async file(id: string, res: Response) {
    const { storedName, originalName } = await this.imports.archivo(id);
    enviarAdjuntoSeguro(res, join(PAYMENT_IMPORTS_ROOT, storedName), originalName);
  }
}
