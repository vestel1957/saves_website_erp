import { BadRequestException } from '../core/http/errores';
import { PaymentImportsService } from './payment-imports.service';
import { AuthUser } from '../auth/current-user.decorator';

/**
 * Cargue masivo de pagos externos (Efecty) — migrado de saves-vestel `Transactions::cargue_xlxs`.
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

  async upload(file: any, date: string | undefined, user: AuthUser) {
    if (!file?.buffer) throw new BadRequestException('Sube un archivo .xlsx en el campo "file".');
    return this.imports.upload(file.buffer, file.originalname ?? 'cargue.xlsx', date, user);
  }

  process(id: string, user: AuthUser) { return this.imports.process(id, user); }
  remove(id: string) { return this.imports.remove(id); }
}
