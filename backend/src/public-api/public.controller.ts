import { PublicService } from './public.service';

/**
 * API REST pública para integraciones de terceros. Autenticada por clave de API
 * (cabecera `X-API-Key`), NO por sesión de usuario. Solo lectura.
 * Base: `/api/public/v1`.
 */
export class PublicController {
  constructor(private readonly svc: PublicService) {}

  /** Verifica que la clave funciona; no requiere scope. */
  ping() { return { ok: true, service: 'saves-vestel public API', version: 'v1' }; }

  clients(
    page?: string,
    pageSize?: string,
    search?: string,
  ) {
    return this.svc.clients({ page: Number(page), pageSize: Number(pageSize), search });
  }

  client(id: string) { return this.svc.clientById(id); }

  clientInvoices(
    id: string,
    page?: string,
    pageSize?: string,
  ) {
    return this.svc.clientInvoices(id, { page: Number(page), pageSize: Number(pageSize) });
  }
}
