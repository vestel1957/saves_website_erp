import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlayhubClient, PLAYHUB_CATALOG, playhubProductName, playhubErrorMessage } from './playhub.client';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SUB_SELECT = {
  id: true, email: true, pppPassword: true, pppUsername: true,
  firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true,
  phone1: true, abonado: true, docNumber: true,
} as const;

type SubRow = {
  id: string; email: string | null; pppPassword: string | null; pppUsername: string | null;
  firstName: string | null; secondName: string | null; lastName1: string | null; lastName2: string | null;
  companyName: string | null; fullName: string | null; phone1: string | null; abonado: number | null; docNumber: string | null;
};

function fullName(s: SubRow): string {
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  return [s.firstName, s.lastName1].map((p) => (p || '').trim()).filter(Boolean).join(' ') || (s.companyName || '').trim() || 'Cliente';
}

/**
 * Integración con PlayHub (OTT/IPTV) — porta la lógica de `Customers.php` del
 * legacy. Invariante de negocio: **el LOGIN de PlayHub ES el email** del cliente
 * (trim, inmutable). Cada operación (subscribe/unsubscribe/sync) refleja el
 * resultado en la tabla local `PlayhubSubscription` para el reporte "Clientes
 * PlayHub" (la API no expone un listado masivo).
 */
@Injectable()
export class PlayhubService {
  private readonly logger = new Logger('PlayhubService');
  /** Guard opcional de megas (0 = desactivado, como en la operación actual). */
  private get minMegas() {
    return Number(process.env.PLAYHUB_MIN_MEGAS ?? 0);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: PlayhubClient,
  ) {}

  status() {
    return this.client.status();
  }

  /** Catálogo de productos (para el selector de suscripción). */
  catalog() {
    return Object.entries(PLAYHUB_CATALOG).map(([code, v]) => ({ code, ...v }));
  }

  /** LOGIN de PlayHub = email del cliente (trim). Inmutable. */
  private login(email: string | null): string {
    return (email || '').trim();
  }

  private async loadSub(subscriberId: string): Promise<SubRow> {
    const s = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: SUB_SELECT });
    if (!s) throw new NotFoundException('Cliente no encontrado');
    return s;
  }

  /** Suscripciones EN VIVO del cliente (consulta a PlayHub). */
  async liveSubscriptions(subscriberId: string) {
    const s = await this.loadSub(subscriberId);
    const login = this.login(s.email);
    if (!login) throw new BadRequestException('El cliente no tiene email; no tiene cuenta en PlayHub.');
    if (!this.client.isConfigured) throw new BadRequestException('PlayHub no está configurado.');
    const resp = await this.client.getSubscriptions(login);
    if (resp.httpCode === 200) {
      return { login, subscriptions: Array.isArray(resp.data) ? resp.data : [] };
    }
    if (resp.httpCode === 404) return { login, subscriptions: [] };
    throw new BadRequestException(playhubErrorMessage(resp));
  }

  /** Suscribir un producto. Crea el cliente en PlayHub si no existe (404) y reintenta. */
  async subscribe(subscriberId: string, productId: string) {
    if (!productId) throw new BadRequestException('Producto requerido');
    const s = await this.loadSub(subscriberId);
    const login = this.login(s.email);
    if (!login) throw new BadRequestException('El cliente no tiene email. Cárgalo para registrarlo en PlayHub.');
    if (!this.client.isConfigured) throw new BadRequestException('PlayHub no está configurado.');

    if (this.minMegas > 0) {
      // Guard de elegibilidad (deshabilitado por defecto). La medición de megas se
      // cablea cuando el negocio reactive la regla; por ahora no bloquea.
      this.logger.warn(`PLAYHUB_MIN_MEGAS=${this.minMegas} configurado pero la medición de megas no está cableada; no se aplica el guard.`);
    }

    const password = s.pppPassword || '';
    const name = fullName(s);
    let resp = await this.client.createSubscription(login, productId);

    if (resp.httpCode === 404) {
      const cr = await this.client.createCustomer(login, password, name, '', s.email || '', s.phone1 || '');
      if (![200, 201].includes(cr.httpCode)) {
        throw new BadRequestException('No se pudo crear el cliente en PlayHub: ' + playhubErrorMessage(cr));
      }
      resp = await this.client.createSubscription(login, productId);
    }

    if ([200, 201].includes(resp.httpCode)) {
      const voucher = resp.data?.Voucher ?? null;
      await this.addLocal(s.id, s.pppUsername, productId, playhubProductName(productId), voucher);
      return { ok: true, message: 'Suscripción creada', voucher, data: resp.data };
    }
    throw new BadRequestException(playhubErrorMessage(resp));
  }

  /** Cancelar una suscripción. */
  async unsubscribe(subscriberId: string, productId: string) {
    if (!productId) throw new BadRequestException('Producto requerido');
    const s = await this.loadSub(subscriberId);
    const login = this.login(s.email);
    if (!login) throw new BadRequestException('El cliente no tiene email; no tiene cuenta en PlayHub.');
    if (!this.client.isConfigured) throw new BadRequestException('PlayHub no está configurado.');

    const resp = await this.client.deleteSubscription(login, productId);
    if (resp.httpCode === 200 || resp.httpCode === 204 || resp.httpCode === 404) {
      await this.removeLocal(s.id, productId);
      return { ok: true, message: 'Suscripción cancelada' };
    }
    throw new BadRequestException(playhubErrorMessage(resp));
  }

  /** Sincroniza (crea/actualiza) la cuenta del cliente en PlayHub. */
  async syncCustomer(subscriberId: string) {
    const s = await this.loadSub(subscriberId);
    const login = this.login(s.email);
    if (!login) throw new BadRequestException('El cliente no tiene email; no se puede registrar en PlayHub.');
    if (!this.client.isConfigured) throw new BadRequestException('PlayHub no está configurado.');

    const password = s.pppPassword || '';
    const name = fullName(s);
    let resp = await this.client.updateCustomer(login, password, name, s.email || '', s.phone1 || '');
    if (resp.httpCode === 404) {
      resp = await this.client.createCustomer(login, password, name, '', s.email || '', s.phone1 || '');
      if (resp.data?.Code === 2) {
        resp = await this.client.updateCustomer(login, password, name, s.email || '', s.phone1 || '');
      }
    }
    if ([200, 201].includes(resp.httpCode)) return { ok: true, message: 'Cliente sincronizado con PlayHub' };
    throw new BadRequestException(playhubErrorMessage(resp));
  }

  /** Refresca la tabla local de un cliente contra sus suscripciones en vivo. */
  async syncSubscriber(subscriberId: string) {
    const { subscriptions } = await this.liveSubscriptions(subscriberId);
    const s = await this.loadSub(subscriberId);
    await this.prisma.$transaction(async (tx) => {
      await tx.playhubSubscription.deleteMany({ where: { subscriberId } });
      if (subscriptions.length) {
        await tx.playhubSubscription.createMany({
          data: subscriptions.map((sub: any) => {
            const pid = sub.ProductId ?? sub.productId ?? null;
            return {
              subscriberId, nameS: s.pppUsername,
              productId: pid, productName: pid ? playhubProductName(pid) : (sub.ProductName ?? null),
              voucher: sub.Voucher ?? sub.voucher ?? null, syncedAt: new Date(),
            };
          }),
        });
      }
    });
    return { ok: true, count: subscriptions.length };
  }

  /**
   * Sincronización masiva: refresca la tabla local de todos los clientes que ya
   * tienen suscripciones locales (bounded). La API de PlayHub no expone un listado
   * masivo, así que se recorre por cliente con concurrencia limitada.
   */
  async syncAll(limit = 500) {
    if (!this.client.isConfigured) throw new BadRequestException('PlayHub no está configurado.');
    const rows = await this.prisma.playhubSubscription.findMany({
      where: { subscriberId: { not: null } }, distinct: ['subscriberId'], select: { subscriberId: true }, take: limit,
    });
    const ids = rows.map((r) => r.subscriberId).filter((x): x is string => !!x);
    let ok = 0, failed = 0;
    for (const id of ids) {
      try { await this.syncSubscriber(id); ok++; } catch { failed++; }
      await sleep(80);
    }
    return { ok: true, synced: ok, failed, total: ids.length };
  }

  // ---------- Tabla local ----------

  private async addLocal(subscriberId: string, nameS: string | null, productId: string, productName: string, voucher: string | null) {
    await this.prisma.$transaction(async (tx) => {
      await tx.playhubSubscription.deleteMany({ where: { subscriberId, productId } });
      await tx.playhubSubscription.create({
        data: { subscriberId, nameS, productId, productName, voucher, syncedAt: new Date() },
      });
    });
  }

  private async removeLocal(subscriberId: string, productId: string) {
    await this.prisma.playhubSubscription.deleteMany({ where: { subscriberId, productId } });
  }

  /** Suscripciones locales de un cliente (para la ficha). */
  async localSubscriptions(subscriberId: string) {
    const rows = await this.prisma.playhubSubscription.findMany({
      where: { subscriberId }, orderBy: { syncedAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id, productId: r.productId, productName: r.productName, voucher: r.voucher, syncedAt: r.syncedAt,
    }));
  }
}
