import { UnauthorizedException } from '../core/http/errores';
import { PrismaService } from '../prisma/prisma.service';
import { signSubscriberToken } from '../auth/crypto.util';
import { num } from '../common/money';

/** Normaliza un documento para comparar (quita puntos/espacios/guiones). */
const normDoc = (s: string) => s.replace(/[.\s-]/g, '').toLowerCase();

function fullName(s: { firstName: string | null; lastName1: string | null; lastName2: string | null; companyName: string | null; fullName: string | null }): string {
  if (s.fullName?.trim()) return s.fullName.trim();
  const parts = [s.firstName, s.lastName1, s.lastName2].filter(Boolean).join(' ').trim();
  return parts || s.companyName?.trim() || 'Cliente';
}

export class PortalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Autentica al abonado por número de abonado + documento. */
  async login(abonado: number, document: string) {
    // OJO: ~4k números de abonado están duplicados en la BD (basura del legacy
    // con estados DEPURADO/RETIRADO). Por eso NO basta findFirst por abonado y
    // luego validar el documento: hay que emparejar abonado + documento juntos
    // (el par es único salvo 3 colisiones) y, ante empate, preferir la cuenta
    // vigente sobre las depuradas/retiradas.
    const subs = await this.prisma.subscriber.findMany({
      where: { abonado },
      select: { id: true, abonado: true, docNumber: true, status: true },
    });
    const target = normDoc(document);
    const matches = subs.filter((s) => s.docNumber && normDoc(s.docNumber) === target);
    // Mensaje genérico (no revela si el abonado existe).
    if (matches.length === 0) {
      throw new UnauthorizedException('Número de abonado o documento incorrecto.');
    }
    const DEAD = new Set(['DEPURADO', 'RETIRADO']);
    const chosen = matches.find((s) => !DEAD.has(s.status ?? '')) ?? matches[0];
    return { token: signSubscriberToken({ id: chosen.id, abonado: chosen.abonado }) };
  }

  /** Resumen de cuenta del abonado autenticado: datos, deuda y facturas pendientes. */
  async me(subscriberId: string) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, abonado: true, email: true, addressLine: true,
        firstName: true, lastName1: true, lastName2: true, companyName: true, fullName: true,
      },
    });
    if (!sub) throw new UnauthorizedException('Cuenta no encontrada.');

    const invoices = await this.prisma.subInvoice.findMany({
      where: { subscriberId, status: { in: ['DUE', 'PARTIAL'] } },
      orderBy: [{ invoiceDate: 'asc' }, { tid: 'asc' }],
      select: { id: true, tid: true, invoiceDate: true, dueDate: true, total: true, paidAmount: true },
    });
    const items = invoices.map((i) => ({
      id: i.id, tid: i.tid, date: i.invoiceDate, dueDate: i.dueDate,
      total: num(i.total), saldo: Math.max(0, num(i.total) - num(i.paidAmount)),
    }));
    const debt = items.reduce((s, i) => s + i.saldo, 0);

    return {
      subscriber: { id: sub.id, abonado: sub.abonado, name: fullName(sub), email: sub.email, address: sub.addressLine },
      debt, invoices: items,
    };
  }
}
