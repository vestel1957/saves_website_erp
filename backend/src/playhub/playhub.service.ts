import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { PlayhubClient, PLAYHUB_CATALOG, playhubProductName, playhubErrorMessage } from './playhub.client';

/** Fila "solo cuenta": el cliente tiene cuenta en PlayHub pero ninguna suscripción. */
const SOLO_CUENTA = '';

const SUB_SELECT = {
  id: true, email: true, pppPassword: true, pppUsername: true,
  firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true,
  phone1: true, abonado: true, docNumber: true, pppProfile: true,
} as const;

type SubRow = {
  id: string; email: string | null; pppPassword: string | null; pppUsername: string | null;
  firstName: string | null; secondName: string | null; lastName1: string | null; lastName2: string | null;
  companyName: string | null; fullName: string | null; phone1: string | null; abonado: number | null; docNumber: string | null;
  pppProfile: string | null;
};

/**
 * Megas que nombra un plan: '300 Megas ST' → 300, '5MegasV' → 5. 0 si no se puede
 * determinar ('no', '-', vacío). Mismo regex que `playhub_megas_de_combo` del legacy.
 */
export function megasDePlan(nombre?: string | null): number {
  const t = (nombre ?? '').trim();
  if (!t || t === 'no' || t === '-') return 0;
  const m = t.match(/(\d+)\s*[Mm]ega/);
  return m ? Number(m[1]) : 0;
}

/** Progreso de la barrida masiva (en memoria: es un proceso, no un dato). */
type EstadoBarrida = {
  running: boolean;
  total: number;
  hechos: number;
  conSuscripcion: number;
  sinSuscripcion: number;
  errores: number;
  detalle: string[];
  startedAt: string | null;
  finishedAt: string | null;
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
export class PlayhubService {
  private readonly logger = new Logger('PlayhubService');

  /**
   * Regla de negocio (`PLAYHUB_MIN_MEGAS`): PlayHub sólo se asigna a clientes con
   * internet de 100 Megas en adelante (antes eran 300). 0 lo apaga.
   */
  private get minMegas() {
    return Number(process.env.PLAYHUB_MIN_MEGAS ?? 100);
  }

  /** Estado de la barrida masiva. Vive en memoria del proceso. */
  private barrida: EstadoBarrida = {
    running: false, total: 0, hechos: 0, conSuscripcion: 0, sinSuscripcion: 0,
    errores: 0, detalle: [], startedAt: null, finishedAt: null,
  };

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
      const { megas } = await this.megasDeCliente(s);
      if (megas < this.minMegas) {
        throw new BadRequestException(
          `PlayHub sólo puede asignarse a clientes con plan de internet de ${this.minMegas} Megas en adelante. ` +
            `Plan actual: ${megas > 0 ? megas + ' Megas' : 'sin internet'}.`,
        );
      }
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
      await this.removeLocal(s.id, productId, s.pppUsername);
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
   * Barrida masiva: refresca la tabla local contra PlayHub para TODOS los clientes
   * con email, igual que `Customers::playhub_sync_suscripciones` del legacy.
   *
   * El login de PlayHub es el email, así que los clientes sin email no tienen cuenta
   * y no se consultan. La API no expone un listado masivo: hay que preguntar cliente
   * por cliente, y son ~15.000 GET. Por eso va en LOTES en paralelo y, a diferencia
   * del legacy (que bloquea la petición hasta 10 min), corre EN SEGUNDO PLANO: el
   * endpoint devuelve al momento y el progreso se consulta con `syncStatus()`. Una
   * barrida de 5 minutos colgada de un request se la come el timeout del proxy.
   */
  async syncAll(limit?: number) {
    if (!this.client.isConfigured) throw new BadRequestException('PlayHub no está configurado.');
    if (this.barrida.running) return { ok: true, yaEnCurso: true, ...this.barrida };

    const subs = await this.prisma.subscriber.findMany({
      where: { email: { not: null } },
      select: { id: true, email: true, pppUsername: true },
      ...(limit && limit > 0 ? { take: limit } : {}),
    });

    // Mapa login(email) → cliente. Un email repetido es UNA sola cuenta en PlayHub:
    // se queda el primero, como el legacy.
    const porLogin = new Map<string, { id: string; pppUsername: string | null }>();
    for (const c of subs) {
      const login = this.login(c.email);
      if (!login || porLogin.has(login)) continue;
      porLogin.set(login, { id: c.id, pppUsername: c.pppUsername });
    }

    this.barrida = {
      running: true, total: porLogin.size, hechos: 0, conSuscripcion: 0, sinSuscripcion: 0,
      errores: 0, detalle: [], startedAt: new Date().toISOString(), finishedAt: null,
    };
    void this.correrBarrida(porLogin);
    return { ok: true, yaEnCurso: false, ...this.barrida };
  }

  /** Progreso de la barrida masiva (lo pregunta la pantalla mientras corre). */
  syncStatus() {
    return { ...this.barrida, detalle: this.barrida.detalle.slice(0, 50) };
  }

  private async correrBarrida(porLogin: Map<string, { id: string; pppUsername: string | null }>) {
    const logins = [...porLogin.keys()];
    const TAM = 30;
    try {
      for (let i = 0; i < logins.length; i += TAM) {
        const lote = logins.slice(i, i + TAM);
        const respuestas = await this.client.getSubscriptionsMulti(lote, TAM);

        // Los que hay que reescribir en la tabla local, en una sola transacción por lote.
        const aBorrar: string[] = [];
        const aCrear: { subscriberId: string; nameS: string | null; productId: string; productName: string | null; voucher: string | null; syncedAt: Date }[] = [];
        const ahora = new Date();

        for (const login of lote) {
          const c = porLogin.get(login)!;
          const resp = respuestas.get(login) ?? { httpCode: 0, data: null, error: 'Sin respuesta' };

          if (resp.httpCode !== 200) {
            // 404 = no tiene cuenta en PlayHub → se trata como "sin suscripciones".
            if (resp.httpCode === 404) {
              aBorrar.push(c.id);
              this.barrida.sinSuscripcion++;
            } else {
              this.barrida.errores++;
              if (this.barrida.detalle.length < 200) this.barrida.detalle.push(`${login}: ${playhubErrorMessage(resp)}`);
            }
            continue;
          }

          const crudas = Array.isArray(resp.data) ? resp.data : [];
          aBorrar.push(c.id);
          let n = 0;
          for (const sub of crudas) {
            const pid = sub?.ProductId ?? sub?.productId ?? null;
            if (!pid) continue;
            aCrear.push({
              subscriberId: c.id, nameS: c.pppUsername, productId: pid,
              productName: playhubProductName(pid), voucher: sub?.Voucher ?? sub?.voucher ?? null, syncedAt: ahora,
            });
            n++;
          }
          if (n > 0) this.barrida.conSuscripcion++;
          else this.barrida.sinSuscripcion++;
        }

        if (aBorrar.length) {
          await this.prisma.$transaction([
            this.prisma.playhubSubscription.deleteMany({ where: { subscriberId: { in: aBorrar } } }),
            ...(aCrear.length ? [this.prisma.playhubSubscription.createMany({ data: aCrear })] : []),
          ]);
        }
        this.barrida.hechos += lote.length;
      }
    } catch (e) {
      this.barrida.errores++;
      this.barrida.detalle.push(`Barrida interrumpida: ${(e as Error).message}`);
      this.logger.error(`Barrida PlayHub interrumpida: ${(e as Error).message}`);
    } finally {
      this.barrida.running = false;
      this.barrida.finishedAt = new Date().toISOString();
      this.logger.log(
        `Barrida PlayHub: ${this.barrida.conSuscripcion} con suscripción, ${this.barrida.sinSuscripcion} sin, ${this.barrida.errores} errores de ${this.barrida.total}`,
      );
    }
  }

  /**
   * Megas de internet contratadas, para el guard de elegibilidad. Va probando por
   * el mismo orden que el resto de la ficha, porque `SubscriberService` no está
   * completo: servicio registrado → plan de la última factura → perfil del router.
   */
  async megasDeCliente(s: SubRow): Promise<{ megas: number; plan: string | null }> {
    const svc = await this.prisma.subscriberService.findFirst({
      where: { subscriberId: s.id, kind: 'INTERNET' },
      select: { planName: true, megas: true },
    });
    if (svc) {
      const m = svc.megas ?? megasDePlan(svc.planName);
      if (m > 0) return { megas: m, plan: svc.planName ?? null };
    }
    const inv = await this.prisma.subInvoice.findFirst({
      where: { subscriberId: s.id },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      select: { serviceCombo: true },
    });
    const mFactura = megasDePlan(inv?.serviceCombo);
    if (mFactura > 0) return { megas: mFactura, plan: inv?.serviceCombo ?? null };

    const mPerfil = megasDePlan(s.pppProfile);
    if (mPerfil > 0) return { megas: mPerfil, plan: s.pppProfile };
    return { megas: 0, plan: null };
  }

  /** Elegibilidad del cliente para PlayHub (la usa el panel de la ficha). */
  async eligibility(subscriberId: string) {
    const s = await this.loadSub(subscriberId);
    const { megas, plan } = await this.megasDeCliente(s);
    return { megas, plan, minMegas: this.minMegas, elegible: this.minMegas <= 0 || megas >= this.minMegas };
  }

  // ---------- Tabla local ----------

  private async addLocal(subscriberId: string, nameS: string | null, productId: string, productName: string, voucher: string | null) {
    await this.prisma.$transaction(async (tx) => {
      // Ya tiene suscripción de verdad: fuera el placeholder de "solo cuenta".
      await tx.playhubSubscription.deleteMany({ where: { subscriberId, productId: { in: [productId, SOLO_CUENTA] } } });
      await tx.playhubSubscription.create({
        data: { subscriberId, nameS, productId, productName, voucher, syncedAt: new Date() },
      });
    });
  }

  /**
   * Quita una suscripción de la tabla local. El cliente SIGUE teniendo cuenta en
   * PlayHub aunque se le quite todo, así que si se queda sin ninguna se deja la
   * fila "solo cuenta" (como el legacy) para que no desaparezca del reporte.
   */
  private async removeLocal(subscriberId: string, productId: string, nameS: string | null) {
    await this.prisma.$transaction(async (tx) => {
      await tx.playhubSubscription.deleteMany({ where: { subscriberId, productId } });
      const restantes = await tx.playhubSubscription.count({ where: { subscriberId } });
      if (restantes === 0) {
        await tx.playhubSubscription.create({
          data: { subscriberId, nameS, productId: SOLO_CUENTA, productName: null, voucher: null, syncedAt: new Date() },
        });
      }
    });
  }

  /** Suscripciones locales de un cliente (para la ficha). Sin el placeholder de "solo cuenta". */
  async localSubscriptions(subscriberId: string) {
    const rows = await this.prisma.playhubSubscription.findMany({
      where: { subscriberId, NOT: { productId: SOLO_CUENTA } }, orderBy: { syncedAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id, productId: r.productId, productName: r.productName, voucher: r.voucher, syncedAt: r.syncedAt,
    }));
  }
}
