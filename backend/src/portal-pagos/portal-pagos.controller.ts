import type { Request, Response } from 'express';
import { Logger } from '../core/logger';
import { PortalPagosService } from './portal-pagos.service';

/**
 * Web service PÚBLICO del portal de pagos en línea (`vestel.com.co/crm`).
 *
 * No lleva `autenticar`: el portal es un CodeIgniter que no sabe de sesiones de este
 * sistema. La puerta es el apretón de manos que ya usaba contra el legacy (dos md5 en
 * el cuerpo) más una lista de IPs — ver `PortalPagosService.exigirFirma`.
 *
 * Los cinco métodos responden con la MISMA forma que servía
 * `saves-vestel/application/controllers/Servicio.php`, porque el portal hace
 * `json_decode` y va directo a las llaves. Aquí no se puede "mejorar" la respuesta:
 * cualquier llave que falte es una página en blanco para un cliente que está pagando.
 *
 * Todos son POST con el cuerpo en JSON, igual que allá. Y todos devuelven 200 con el
 * error dentro cuando algo va mal a propósito: `Communication_model::obtener()` no
 * mira el código HTTP, sólo `json_decode` lo que venga, así que un 500 se vería en
 * pantalla como un error de PHP y no como un mensaje.
 */
export class PortalPagosController {
  private readonly logger = new Logger('PortalPagosController');

  constructor(private readonly portal: PortalPagosService) {}

  /** `POST /api/portal-pagos/get_due_customer` — deuda, ficha, promos y llaves de Wompi. */
  async getDueCustomer(req: Request, body: any, res: Response) {
    return this.responder(req, body, res, () => this.portal.getDueCustomer(Number(body?.cid)));
  }

  /** `POST /api/portal-pagos/inv_list` — tabla de facturas (DataTables server-side). */
  async invList(req: Request, body: any, res: Response) {
    return this.responder(req, body, res, () => this.portal.invList({
      cid: Number(body?.cid),
      start: Number(body?.start) || 0,
      length: Number(body?.length) || 10,
      search: typeof body?.search === 'string' ? body.search : '',
      order: Array.isArray(body?.order) ? body.order : [],
      draw: Number(body?.draw) || 0,
    }));
  }

  /**
   * `POST /api/portal-pagos/view_service` — el HTML de una factura.
   *
   * Devuelve texto, no JSON: el portal lo imprime tal cual entre su cabecera y su pie.
   */
  async viewService(req: Request, body: any, res: Response) {
    try {
      this.portal.exigirFirma(body, ipDe(req));
      if (!this.portal.habilitado) return res.status(503).send('');
      const html = await this.portal.viewService(Number(body?.tid), Number(body?.cid) || undefined);
      return res.type('html').send(html);
    } catch (e: any) {
      this.logger.warn(`[portal-pagos] view_service: ${e?.message ?? e}`);
      return res.type('html').send(`<div class="alert alert-warning">${e?.message ?? 'No se pudo abrir la factura.'}</div>`);
    }
  }

  /** `POST /api/portal-pagos/aplicar_discount` — sin efecto: el valor ya viene rebajado. */
  async aplicarDiscount(req: Request, body: any, res: Response) {
    return this.responder(req, body, res, async () => this.portal.aplicarDiscount(Number(body?.cid), body?.promo));
  }

  /** `POST /api/portal-pagos/pay_due_customer` — aplica el pago que Wompi ya cobró. */
  async payDueCustomer(req: Request, body: any, res: Response) {
    return this.responder(req, body, res, () => this.portal.payDueCustomer(
      Number(body?.cid), Number(body?.monto), String(body?.idorden ?? ''),
    ));
  }

  /**
   * Envoltorio común: apretón de manos, gate y respuesta.
   *
   * El error viaja DENTRO del JSON y con 200, salvo el 403 del apretón de manos (ahí sí
   * conviene que se note) y el 503 del gate cerrado. Ver la cabecera de la clase.
   */
  private async responder(req: Request, body: any, res: Response, fn: () => Promise<unknown>) {
    try {
      this.portal.exigirFirma(body, ipDe(req));
    } catch (e: any) {
      return res.status(403).json({ error: e?.message ?? 'No autorizado' });
    }
    if (!this.portal.habilitado) {
      // 503 y no 200: que el portal falle a la vista es preferible a que enseñe una
      // deuda vacía y le cobre $0 a alguien.
      return res.status(503).json({ error: 'Web service del portal apagado.' });
    }
    try {
      return res.json(await fn());
    } catch (e: any) {
      this.logger.warn(`[portal-pagos] ${req.path}: ${e?.message ?? e}`);
      return res.json({ error: e?.message ?? 'Error inesperado' });
    }
  }
}

/**
 * La IP de quien llama. El backend va detrás del proxy de `app.saves.com.co`, así que
 * la buena es la primera de `X-Forwarded-For` cuando la hay.
 */
function ipDe(req: Request): string | null {
  const xff = req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? null;
}
