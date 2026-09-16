import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { orden } from '../common/pagination-params';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { SignatureOtpService } from '../common/signature/signature-otp.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { NotificationsService } from '../common/notifications/notifications.service';
import { pdfToBuffer } from '../common/pdf/pdf-buffer';
import { actaPdf, ActaPdfData } from '../common/pdf/pdf-docs';
import { hoyEnColombia } from '../common/fecha-colombia';
import { esJefeDeBodega, esSuperusuario, exigirBodegaDeSuSede, sedesDeUsuario } from './bodega-scope';
import { clavesDe, esTecnicoDeCampo, fichaDelUsuario } from '../common/tecnico-scope';
import { cajerasDeSede } from '../common/sede-scope';

export class EquipTransferDto {
  @IsString() fromWarehouseId!: string;
  @IsString() toWarehouseId!: string;
  @IsOptional() @IsString() observations?: string;
  @IsArray() @IsString({ each: true }) equipmentIds!: string[];
}
export class AssignPortDto {
  @IsString() @MinLength(1) subscriberId!: string;
}
export class RejectTransferDto {
  @IsOptional() @IsString() reason?: string;
}
/** Código de firma (6 dígitos) para despachar o recibir entre sedes. */
/**
 * Firmar la salida. El código es OPCIONAL porque `signature.otpRequired` puede
 * estar apagado: con el DTO exigiéndolo, apagar el ajuste dejaba la salida
 * imposible de confirmar (400 antes de llegar al servicio). Quién puede firmar se
 * sigue comprobando en `contextoDeFirma`, que eso no lo apaga ningún ajuste.
 */
export class SignTransferDto {
  @IsOptional() @IsString() @MinLength(4) code?: string;
}
/** Recibir: el código solo hace falta cuando la transferencia cruza sedes. */
export class ReceiveTransferDto {
  @IsOptional() @IsString() code?: string;
}

/**
 * Pool de IP (legacy `ips_users_mk`). Los campos son los mismos que el formulario del
 * legacy (views/mikrotiks/ips_users.php): nombre, ip_local, ip_remota, tegnologia,
 * sede y perfiles. `defecto` no se manda aquí: se decide solo al crear y se cambia
 * con su propia ruta, igual que en el legacy.
 */
export class CreateIpPoolDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) ipLocal!: string;
  @IsString() @MinLength(1) ipRemote!: string;
  @IsString() branchId!: string;
  @IsOptional() @IsString() tech?: string;
  /** Perfiles PPPoE separados por coma, como los guarda el legacy. */
  @IsOptional() @IsString() profiles?: string;
}

export class UpdateIpPoolDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() @MinLength(1) ipLocal?: string;
  @IsOptional() @IsString() @MinLength(1) ipRemote?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() tech?: string;
  @IsOptional() @IsString() profiles?: string;
}
export class CreateEquipmentDto {
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() mac?: string;
  @IsOptional() @IsString() serial?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() observation?: string;
}
/**
 * Edición de un equipo desde inventario (2026-09-14). Los topes son los de las
 * columnas de `equipos` en el legacy (`invEquipo` en writeback-legacy.js): más largo
 * se recortaría al subir. La bodega NO va aquí: moverla es una transferencia.
 */
export class UpdateEquipmentDto {
  @IsOptional() @IsString() @MaxLength(20) brand?: string;
  @IsOptional() @IsString() @MaxLength(100) mac?: string;
  @IsOptional() @IsString() @MaxLength(100) serial?: string;
  @IsOptional() @IsString() @MaxLength(16) status?: string;
  @IsOptional() @IsString() @MaxLength(200) observation?: string;
}
/** Estados que se pueden poner a mano. "Asignado"/"Reservado" los ponen la asignación y la reserva. */
export const ESTADOS_EQUIPO_EDITABLES = ['Disponible', 'Bueno', 'Malo', 'Depurado'];
export class CreateVlanDto {
  @IsString() @MinLength(1) branchId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(4094) vlan!: number;
  @IsString() @MinLength(1) detail!: string;
  @IsOptional() @IsString() olt?: string;
  @IsOptional() @Type(() => Number) @IsInt() tray?: number;
  @IsOptional() @Type(() => Number) @IsInt() oltPort?: number;
}
export class UpdateNapDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() vlanId?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() gpsLat?: string;
  @IsOptional() @IsString() gpsLng?: string;
}
export class AssignEquipmentSubDto {
  @IsString() @MinLength(1) subscriberId!: string;
  @IsOptional() @IsString() installType?: string;
  @IsOptional() @Type(() => Number) @IsInt() port?: number;
  @IsOptional() @Type(() => Number) @IsInt() vlan?: number;
  @IsOptional() @Type(() => Number) @IsInt() meters?: number;
  @IsOptional() @IsString() master?: string;
}
export class CreateNapDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) branchId!: string;
  @IsOptional() @IsString() vlanId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(256) portCount!: number;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() gpsLat?: string;
  @IsOptional() @IsString() gpsLng?: string;
}

function subName(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string | null {
  if (!s) return null;
  return (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || null;
}

export class NetworkWriteService {
  private readonly logger = new Logger('NetworkWrite');

  constructor(
    private readonly prisma: PrismaService,
    private readonly firma: SignatureOtpService,
    private readonly whatsapp: WhatsappService,
    private readonly avisos: NotificationsService,
    /** Opcional: sin él el equipo se suelta igual, pero su ONU sigue dada de alta en la OLT. */
    private readonly onuAlDevolver?: import('./onu-al-devolver.service').OnuAlDevolverService,
  ) {}

  // ── Transferencias de equipos: sede y firmas ────────────────────────────────
  //
  // Reglas de negocio (2026-07-30, decisión del usuario):
  //  · Una cajera es la encargada de SU sede: solo ve y mueve las bodegas de sus
  //    sedes (`bodega-scope.ts`).
  //  · Mandar equipo de una sede a OTRA es solo del encargado de bodega.
  //  · Y en ese caso el equipo no se mueve con un clic: la cajera de la sede ORIGEN
  //    firma la SALIDA con un código que le llega al WhatsApp, y quien recibe en la
  //    sede DESTINO firma la ENTRADA con el suyo. Dentro de una misma sede el flujo
  //    sigue como estaba (solicitud → aprueba el jefe → se recibe), sin código.

  /** ¿Esta transferencia cruza sedes? Una bodega sin sede ("Depurados") cuenta como otra. */
  private esEntreSedes(from: { branchLegacy: number | null }, to: { branchLegacy: number | null }): boolean {
    return from.branchLegacy !== to.branchLegacy;
  }

  /** Nombre de sede por `Branch.legacyId`, para hablarle claro al usuario. */
  private async nombreSede(legacyId: number | null): Promise<string> {
    if (legacyId == null) return 'sin sede';
    const b = await this.prisma.branch.findUnique({ where: { legacyId }, select: { name: true } });
    return b?.name ?? `sede ${legacyId}`;
  }

  /** Las dos bodegas de una transferencia, con su sede. */
  private async bodegasDe(t: { fromWarehouseId: string | null; toWarehouseId: string | null; fromWarehouse: string; toWarehouse: string }) {
    const porId = async (id: string | null, legacy: string) => {
      if (id) return this.prisma.equipmentWarehouse.findUnique({ where: { id } });
      const n = Number(legacy);
      return Number.isFinite(n) && n > 0 ? this.prisma.equipmentWarehouse.findUnique({ where: { legacyId: n } }) : null;
    };
    const [from, to] = await Promise.all([
      porId(t.fromWarehouseId, t.fromWarehouse),
      porId(t.toWarehouseId, t.toWarehouse),
    ]);
    return { from, to };
  }

  /** Transferencias de equipos (actas). */
  /** Columnas ordenables de la tabla de transferencias de equipos. */
  private static readonly ORDEN_TRANSFERS = {
    date: 'date', from: 'fromWarehouseName', to: 'toWarehouseName',
    status: 'status', obs: 'observations',
    solicita: 'requestedByName', recibe: 'receivedByName',
    items: (dir: 'asc' | 'desc') => ({ items: { _count: dir } }),
  };

  async transfers(params: { page?: number; pageSize?: number; search?: string; status?: string; warehouseId?: string; sortBy?: string; sortDir?: string }, user?: AuthUser) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));

    const and: Prisma.EquipmentTransferWhereInput[] = [];
    const q = params.search?.trim();
    if (q) {
      const ins = { contains: q, mode: 'insensitive' as const };
      and.push({ OR: [
        { fromWarehouseName: ins }, { toWarehouseName: ins },
        { requestedByName: ins }, { approvedByName: ins }, { receivedByName: ins },
        { observations: ins }, { fromWarehouse: ins }, { toWarehouse: ins },
      ] });
    }
    if (params.status?.trim()) and.push({ status: params.status.trim() });
    if (params.warehouseId?.trim()) {
      const wh = await this.prisma.equipmentWarehouse.findUnique({ where: { id: params.warehouseId.trim() } });
      if (wh) {
        const legacy = String(wh.legacyId ?? '');
        and.push({ OR: [
          { fromWarehouseId: wh.id }, { toWarehouseId: wh.id },
          { fromWarehouseName: wh.name }, { toWarehouseName: wh.name },
          ...(legacy ? [{ fromWarehouse: legacy }, { toWarehouse: legacy }] : []),
        ] });
      } else {
        // Bodega inexistente: no devolver nada en vez de ignorar el filtro.
        and.push({ id: '__none__' });
      }
    }
    // Acotado por sede: una cajera solo ve las transferencias que tocan una bodega
    // de sus sedes (las de otra sede no son asunto suyo, ni siquiera para mirar).
    const sedes = user ? await sedesDeUsuario(this.prisma, user) : null;
    if (sedes !== null) {
      const suyas = sedes.length
        ? await this.prisma.equipmentWarehouse.findMany({ where: { branchLegacy: { in: sedes } }, select: { id: true, legacyId: true } })
        : [];
      if (!suyas.length) {
        and.push({ id: '__none__' }); // sin sede asignada: no ve ninguna
      } else {
        const ids = suyas.map((w) => w.id);
        const legacies = suyas.map((w) => String(w.legacyId));
        and.push({ OR: [
          { fromWarehouseId: { in: ids } }, { toWarehouseId: { in: ids } },
          // Las filas migradas del legacy no tienen `*WarehouseId`, solo el id viejo.
          { fromWarehouse: { in: legacies } }, { toWarehouse: { in: legacies } },
        ] });
      }
    }

    const where: Prisma.EquipmentTransferWhereInput = and.length ? { AND: and } : {};

    const [rows, total] = await Promise.all([
      this.prisma.equipmentTransfer.findMany({ where, orderBy: orden(params, NetworkWriteService.ORDEN_TRANSFERS, { date: 'desc' }), skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { items: true } } } }),
      this.prisma.equipmentTransfer.count({ where }),
    ]);
    // Resolver nombres de bodega (fromWarehouse/toWarehouse legacy id string)
    const whs = await this.prisma.equipmentWarehouse.findMany();
    const byLegacy = new Map(whs.map((w) => [String(w.legacyId), w]));
    const byId = new Map(whs.map((w) => [w.id, w]));
    const sedeNombres = new Map(
      (await this.prisma.branch.findMany({ select: { legacyId: true, name: true } })).map((b) => [b.legacyId, b.name]),
    );
    const bodegaDe = (id: string | null, legacy: string) => (id ? byId.get(id) : undefined) ?? byLegacy.get(legacy);
    return {
      items: rows.map((t) => {
        const from = bodegaDe(t.fromWarehouseId, t.fromWarehouse);
        const to = bodegaDe(t.toWarehouseId, t.toWarehouse);
        return {
          id: t.id, date: t.date,
          from: t.fromWarehouseName ?? from?.name ?? t.fromWarehouse,
          to: t.toWarehouseName ?? to?.name ?? t.toWarehouse,
          fromBranch: from?.branchLegacy != null ? sedeNombres.get(from.branchLegacy) ?? null : null,
          toBranch: to?.branchLegacy != null ? sedeNombres.get(to.branchLegacy) ?? null : null,
          // Las de entre sedes son las que van con firma: la pantalla las marca.
          entreSedes: !!from && !!to && this.esEntreSedes(from, to),
          observations: t.observations, status: t.status ?? 'Emitida', items: t._count.items,
          requestedBy: t.requestedByName, requestedAt: t.requestedAt,
          approvedBy: t.approvedByName, approvedAt: t.approvedAt,
          signedOutBy: t.signedOutByName, signedOutAt: t.signedOutAt,
          receivedBy: t.receivedByName, receivedAt: t.receivedAt,
        };
      }),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async transferDetail(id: string, user?: AuthUser) {
    const [t, firmaCfg] = await Promise.all([
      this.prisma.equipmentTransfer.findUnique({ where: { id }, include: { items: { include: { equipment: true } } } }),
      this.firma.config(),
    ]);
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    const { from, to } = await this.bodegasDe(t);
    const entreSedes = !!from && !!to && this.esEntreSedes(from, to);

    // Acotado por sede: la cajera solo abre las que tocan una bodega suya.
    const sedes = user ? await sedesDeUsuario(this.prisma, user) : null;
    if (sedes !== null) {
      const suya = (w: typeof from) => !!w && w.branchLegacy != null && sedes.includes(w.branchLegacy);
      if (!suya(from) && !suya(to)) throw new ForbiddenException('Esta transferencia no es de tu sede.');
    }

    return {
      id: t.id, date: t.date, from: t.fromWarehouseName ?? t.fromWarehouse, to: t.toWarehouseName ?? t.toWarehouse,
      fromBranch: await this.nombreSede(from?.branchLegacy ?? null),
      toBranch: await this.nombreSede(to?.branchLegacy ?? null),
      entreSedes,
      // ¿Salida y recepción van con código? Lo manda `signature.otpRequired`. La
      // pantalla lo necesita para saber si abrir el diálogo de firma o despachar y
      // recibir de una; `entreSedes` sigue diciendo QUIÉN puede hacerlo, que eso no
      // lo apaga ningún ajuste.
      otpRequired: firmaCfg.required,
      observations: t.observations, status: t.status ?? 'Emitida',
      requestedBy: t.requestedByName, requestedAt: t.requestedAt,
      approvedBy: t.approvedByName, approvedAt: t.approvedAt,
      signedOutBy: t.signedOutByName, signedOutAt: t.signedOutAt, signedOutSignature: t.signedOutSignature,
      receivedBy: t.receivedByName, receivedAt: t.receivedAt, receivedSignature: t.receivedSignature,
      rejectReason: t.rejectReason,
      items: t.items.map((it) => ({ id: it.id, code: it.equipment?.code, mac: it.equipment?.mac, serial: it.equipment?.serial, brand: it.equipment?.brand, status: it.equipment?.status })),
    };
  }

  /**
   * Solicita una transferencia de equipos. NO mueve el equipo: crea la solicitud
   * en estado "Pendiente" con la lista de equipos, a la espera de aprobación (dentro
   * de la sede) o de la firma de salida de la cajera de origen (entre sedes).
   */
  async createTransfer(dto: EquipTransferDto, user: AuthUser) {
    if (dto.fromWarehouseId === dto.toWarehouseId) throw new BadRequestException('Bodega origen y destino deben ser distintas');
    if (!dto.equipmentIds?.length) throw new BadRequestException('Selecciona al menos un equipo');
    const [from, to] = await Promise.all([
      this.prisma.equipmentWarehouse.findUnique({ where: { id: dto.fromWarehouseId } }),
      this.prisma.equipmentWarehouse.findUnique({ where: { id: dto.toWarehouseId } }),
    ]);
    if (!from || !to) throw new NotFoundException('Bodega no encontrada');

    // 1) Entre sedes SOLO el encargado de bodega. Da igual quién lo pida: una cajera
    //    con varias sedes asignadas también podría cruzarlas, y no es su decisión.
    if (this.esEntreSedes(from, to) && !esJefeDeBodega(user)) {
      const [s1, s2] = await Promise.all([this.nombreSede(from.branchLegacy), this.nombreSede(to.branchLegacy)]);
      throw new ForbiddenException(
        `Enviar equipo de ${s1} a ${s2} es del encargado de bodega. Dentro de tu sede sí puedes moverlo.`,
      );
    }
    // 2) Y la cajera solo mueve bodegas de SU sede (las dos puntas).
    const sedes = await sedesDeUsuario(this.prisma, user);
    exigirBodegaDeSuSede(sedes, from);
    exigirBodegaDeSuSede(sedes, to);

    return this.prisma.$transaction(async (tx) => {
      const t = await tx.equipmentTransfer.create({
        data: {
          date: new Date(), fromWarehouse: String(from.legacyId ?? ''), toWarehouse: String(to.legacyId ?? ''),
          fromWarehouseName: from.name, toWarehouseName: to.name, fromWarehouseId: from.id, toWarehouseId: to.id,
          observations: dto.observations ?? null, userId: 0, status: 'Pendiente',
          requestedById: user.id, requestedByName: user.name, requestedAt: new Date(),
        },
      });
      let count = 0;
      for (const eqId of dto.equipmentIds) {
        const eq = await tx.equipment.findUnique({ where: { id: eqId } });
        if (!eq || eq.warehouseId !== dto.fromWarehouseId) continue;
        await tx.equipmentTransferItem.create({ data: { transferId: t.id, equipmentId: eq.id, equipmentLegacy: eq.legacyId ?? 0 } });
        count++;
      }
      if (!count) throw new BadRequestException('Ningún equipo válido en la bodega origen');
      return { id: t.id, status: 'Pendiente', count, entreSedes: this.esEntreSedes(from, to) };
    }).then(async (r) => {
      // Entre sedes el acta sale sola hacia quien tiene que firmar la SALIDA: es lo
      // que convierte "hay una solicitud en el sistema" en "a la encargada de Yopal
      // le llegó el papel". Fuera de la transacción: el PDF y Meta tardan.
      if (!r.entreSedes) return r;
      const envio = await this.enviarActaTransferencia(r.id, 'salida').catch((e) => {
        this.logger.warn(`No se pudo enviar el acta de ${r.id}: ${(e as Error).message}`);
        return { enviado: false as const, a: 0, motivo: 'Error al enviar el acta.' };
      });
      return { ...r, envio };
    });
  }

  /**
   * Aprueba/despacha una solicitud pendiente: el equipo SALE de la bodega origen
   * y queda "En tránsito" (sin bodega) hasta que caja confirme la recepción.
   * Reservado al Jefe de bodega (inventario).
   *
   * Solo DENTRO de una sede: si la transferencia cruza sedes, el que despacha no es
   * quien aprueba sino la cajera encargada de la sede origen, firmando la salida
   * (`firmarSalida`). Si no, el jefe de bodega podría sacar equipo de una sede sin
   * que la responsable de esa sede se entere, que es justo lo que se quiso cerrar.
   */
  async approveTransfer(id: string, user: AuthUser) {
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    if (t.status !== 'Pendiente') throw new BadRequestException('La transferencia no está pendiente de aprobación');

    // Antes que nada: si cruza sedes, esta ruta no es la suya. Va primero que el
    // "no apruebes lo tuyo" porque las de entre sedes SIEMPRE las crea el jefe de
    // bodega —es el único que puede—, y si no, el mensaje que le sale es el que no
    // explica nada ("no puedes aprobar tu propia solicitud") en vez del que dice a
    // quién le toca firmar.
    const { from, to } = await this.bodegasDe(t);
    if (from && to && this.esEntreSedes(from, to)) {
      const sede = await this.nombreSede(from.branchLegacy);
      throw new BadRequestException(
        `Esta transferencia sale de ${sede}: la despacha la cajera encargada de esa sede firmando la salida con su código, no la aprobación de bodega.`,
      );
    }

    if (t.requestedById && t.requestedById === user.id) throw new BadRequestException('No puedes aprobar tu propia solicitud; debe aprobarla inventario');
    if (!t.toWarehouseId || !t.fromWarehouseId) throw new BadRequestException('La solicitud no tiene bodegas válidas (creada antes del flujo de aprobación)');

    return this.despachar(id, t.items, t.fromWarehouseId, {
      status: 'En tránsito', approvedById: user.id, approvedByName: user.name, approvedAt: new Date(),
    });
  }

  /**
   * Saca el equipo de la bodega origen y deja la transferencia "En tránsito".
   * Es el paso común entre aprobar (dentro de la sede) y firmar la salida (entre
   * sedes): mismo movimiento de inventario, distinta autoridad.
   */
  private async despachar(
    id: string,
    items: { equipmentId: string | null; equipmentLegacy: number }[],
    fromWarehouseId: string,
    datos: Prisma.EquipmentTransferUpdateInput,
  ) {
    return this.prisma.$transaction(async (tx) => {
      let dispatched = 0; const skipped: (number | undefined)[] = [];
      for (const it of items) {
        if (!it.equipmentId) { skipped.push(it.equipmentLegacy); continue; }
        const eq = await tx.equipment.findUnique({ where: { id: it.equipmentId } });
        // Revalida: el equipo debe seguir en la bodega origen al momento de despachar.
        if (!eq || eq.warehouseId !== fromWarehouseId) { skipped.push(eq?.code ?? it.equipmentLegacy); continue; }
        await tx.equipment.update({ where: { id: eq.id }, data: { warehouseId: null, editedAt: new Date() } }); // en tránsito
        dispatched++;
      }
      if (!dispatched) throw new BadRequestException('Ningún equipo sigue disponible en la bodega origen');
      await tx.equipmentTransfer.update({ where: { id }, data: datos });
      return { id, status: 'En tránsito', dispatched, skipped: skipped.length };
    });
  }

  // ── Firma de salida y de entrada (transferencias entre sedes) ───────────────

  /**
   * Comprueba que este usuario es quien tiene que firmar ese paso, y devuelve el
   * contexto (bodegas, sede y detalle en prosa para el WhatsApp). Se usa igual al
   * pedir el código que al firmar: pedirlo no puede ser más laxo que usarlo.
   */
  private async contextoDeFirma(id: string, paso: 'salida' | 'entrada', user: AuthUser) {
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    const { from, to } = await this.bodegasDe(t);
    if (!from || !to || !t.fromWarehouseId) throw new BadRequestException('La transferencia no tiene bodegas válidas.');
    if (!this.esEntreSedes(from, to)) {
      throw new BadRequestException('Esta transferencia es dentro de la misma sede: no lleva firma con código.');
    }

    const esperado = paso === 'salida' ? 'Pendiente' : 'En tránsito';
    if (t.status !== esperado) {
      throw new BadRequestException(
        paso === 'salida'
          ? `Esta transferencia ya no está esperando la firma de salida (está "${t.status}").`
          : `Esta transferencia no está en tránsito (está "${t.status}"): no hay nada que recibir.`,
      );
    }

    // Quién firma: la encargada de la sede de esa punta. El superusuario puede
    // firmar en su lugar (misma válvula que las actas de material: una cajera de
    // vacaciones no puede dejar el equipo colgado en tránsito).
    const bodega = paso === 'salida' ? from : to;
    const sedes = await sedesDeUsuario(this.prisma, user);
    if (sedes === null) {
      if (!esSuperusuario(user)) {
        const sede = await this.nombreSede(bodega.branchLegacy);
        throw new ForbiddenException(`Esta firma es de la cajera encargada de ${sede}.`);
      }
    } else {
      exigirBodegaDeSuSede(sedes, bodega);
    }

    const sede = await this.nombreSede(bodega.branchLegacy);
    const detalle =
      paso === 'salida'
        ? `la SALIDA de ${t.items.length} equipo(s) de ${from.name} (${sede}) hacia ${to.name}`
        : `la RECEPCIÓN de ${t.items.length} equipo(s) de ${from.name} en ${to.name} (${sede})`;
    return { t, from, to, sede, detalle };
  }

  /** Datos de la transferencia para el acta en PDF (misma que se descarga y se manda). */
  async transferPdfData(id: string): Promise<ActaPdfData> {
    const t = await this.prisma.equipmentTransfer.findUnique({
      where: { id },
      include: { items: { include: { equipment: true } } },
    });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    const { from, to } = await this.bodegasDe(t);
    const [sedeFrom, sedeTo] = await Promise.all([
      this.nombreSede(from?.branchLegacy ?? null),
      this.nombreSede(to?.branchLegacy ?? null),
    ]);
    return {
      titulo: 'Acta de transferencia de equipos',
      numero: t.legacyId ? String(t.legacyId) : t.id.slice(-6).toUpperCase(),
      date: t.date,
      status: t.status ?? 'Emitida',
      from: t.fromWarehouseName ?? from?.name ?? t.fromWarehouse,
      to: t.toWarehouseName ?? to?.name ?? t.toWarehouse,
      fromBranch: sedeFrom, toBranch: sedeTo,
      observations: t.observations,
      columnaDerecha: 'Serial / MAC',
      items: t.items.map((it) => ({
        descripcion: `Equipo ${it.equipment?.code ?? it.equipmentLegacy}`,
        detalle: it.equipment?.brand ?? null,
        cantidad: it.equipment?.serial ?? it.equipment?.mac ?? '—',
      })),
      // "Entrega" es quien firmó la salida (la encargada de la sede origen); si aún
      // no ha firmado, el renglón queda en blanco y el acta lo dice.
      entrega: { nombre: t.signedOutByName, fecha: t.signedOutAt, nota: t.signedOutSignature },
      recibe: { nombre: t.receivedByName, fecha: t.receivedAt, nota: t.receivedSignature },
    };
  }

  /**
   * Manda el acta en PDF a quien tiene que firmar el siguiente paso.
   *
   * A diferencia del material, aquí no hay un "encargado de bodega de equipos": el
   * que firma es la cajera de esa sede, y pueden ser varias. Se les manda a todas
   * las que podrían firmar —cualquiera puede hacerlo— y se reporta a cuántas llegó.
   */
  private async enviarActaTransferencia(id: string, paso: 'salida' | 'entrada') {
    const data = await this.transferPdfData(id);
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id } });
    if (!t) return { enviado: false as const, a: 0 };
    const { from, to } = await this.bodegasDe(t);
    const bodega = paso === 'salida' ? from : to;
    if (!bodega?.branchLegacy) return { enviado: false as const, a: 0, motivo: 'La bodega de esa punta no tiene sede.' };

    // Quién puede firmar ese paso = cajeras activas de esa sede. Mismo criterio que
    // autoriza la firma (`bodega-scope`), para no avisarle a quien luego no podría.
    // La resolución vive en `common/sede-scope` porque la comparte con la devolución
    // de material del técnico, que también la firma "la cajera de esa sede".
    const destinatarias = await cajerasDeSede(this.prisma, bodega.branchLegacy);
    // La sede es la de ESA punta: en la entrada decía la de origen, que es
    // justo la que no tiene el problema.
    const sedePaso = paso === 'salida' ? data.fromBranch : data.toBranch;
    if (!destinatarias.length) {
      return { enviado: false as const, a: 0, motivo: `Nadie tiene asignada la sede ${sedePaso}: no hay quién firme ese paso (sólo el superusuario puede hacerlo en su lugar).` };
    }

    // La campanita PRIMERO, y pase lo que pase con Meta. Kapso rechaza con
    // `422 outside the 24-hour window` a quien no le haya escrito al bot ese día —el
    // caso normal de una cajera— y hasta ahora eso dejaba la transferencia esperando
    // una firma que nadie sabía que tenía que poner. Ver el mismo arreglo en las
    // actas de material (`InventoryService.enviarActa`).
    await this.avisos.notify(destinatarias.map((c) => c.id), {
      kind: 'red.transferencia',
      title: paso === 'salida'
        ? `Firma la SALIDA de ${data.items.length} equipo(s)`
        : `Equipo en camino: ${data.items.length} equipo(s) por recibir`,
      body: paso === 'salida'
        ? `${data.from} (${data.fromBranch}) → ${data.to}. El equipo no sale hasta que firmes la salida con tu código.`
        : `De ${data.from} a ${data.to} (${data.toBranch}). Cuando llegue, firma la recepción con tu código.`,
      link: '/red/transferencias',
      groupKey: `transferencia:${id}:${paso}`,
    });

    const pdf = await pdfToBuffer((res) => actaPdf(res, data));
    const caption =
      paso === 'salida'
        ? `Sale equipo de ${data.from} (${data.fromBranch}) hacia ${data.to}: ${data.items.length} equipo(s). Para despacharlo, firma la SALIDA en el sistema (Inventario ▸ Transferencias de equipos).`
        : `Va en camino a ${data.to} (${data.toBranch}): ${data.items.length} equipo(s). Cuando llegue, firma la RECEPCIÓN en el sistema.`;

    let enviadas = 0;
    for (const c of destinatarias) {
      const { phone } = await this.firma.telefono(c.id);
      if (!phone) continue;
      if (await this.whatsapp.sendDocument(phone, pdf, `acta-equipos-${data.numero}.pdf`, caption)) enviadas++;
    }
    this.logger.log(`Acta de equipos ${data.numero} (${paso}) enviada a ${enviadas}/${destinatarias.length} encargada(s).`);
    return {
      enviado: enviadas > 0,
      a: enviadas,
      motivo: enviadas ? undefined : 'Ninguna encargada de esa sede recibió el acta por WhatsApp; ya les quedó el aviso en el sistema y el acta está en Transferencias de equipos.',
    };
  }

  /** Manda al WhatsApp del firmante el código para firmar la salida o la entrada. */
  async pedirCodigoFirma(id: string, paso: 'salida' | 'entrada', user: AuthUser) {
    const { detalle } = await this.contextoDeFirma(id, paso, user);
    const r = await this.firma.pedir({
      userId: user.id,
      purpose: paso === 'salida' ? 'equipment.dispatch' : 'equipment.receive',
      targetId: id,
      detalle,
    });
    return { ...r, paso };
  }

  /**
   * Firma la SALIDA: la cajera encargada de la sede origen confirma con su código
   * que el equipo se va, y ahí sí sale de la bodega y queda en tránsito.
   */
  async firmarSalida(id: string, code: string | undefined, user: AuthUser) {
    const { t } = await this.contextoDeFirma(id, 'salida', user);
    // El código lo manda `signature.otpRequired`, igual que las compras y las actas
    // de material. Antes estaba a fuego aquí: apagar el ajuste dejaba el resto del
    // sistema sin código y esta pantalla seguía pidiéndolo, sin forma de despachar.
    // Apagado, la salida queda sellada con quién y cuándo, que es la constancia.
    const { required } = await this.firma.config();
    if (required && !code) throw new BadRequestException('Esta salida va firmada: pide el código y escríbelo para confirmar.');
    const firma = required
      ? await this.firma.firmar({ userId: user.id, purpose: 'equipment.dispatch', targetId: id, code: code! })
      : null;
    const r = await this.despachar(id, t.items, t.fromWarehouseId!, {
      status: 'En tránsito',
      signedOutById: user.id, signedOutByName: user.name, signedOutAt: new Date(),
      signedOutSignature: firma ? SignatureOtpService.rastro(firma) : null,
    });
    // Ya firmada la salida, el acta —ahora con la primera firma puesta— viaja a la
    // sede destino: quien recibe sabe qué esperar antes de que llegue la caja.
    const envio = await this.enviarActaTransferencia(id, 'entrada').catch((e) => {
      this.logger.warn(`No se pudo avisar a la sede destino de ${id}: ${(e as Error).message}`);
      return { enviado: false as const, a: 0 };
    });
    return { ...r, firmadoPor: user.name, envio };
  }

  /**
   * Confirma la recepción de una transferencia "En tránsito": el equipo ENTRA a
   * la bodega destino. La firma quien recibe en la sede destino (caja).
   *
   * Entre sedes va con código: es la segunda mitad de la cadena de custodia (la
   * primera es `firmarSalida`). Dentro de una misma sede se recibe como siempre,
   * con un clic — ahí el equipo no cambió de responsable.
   */
  async receiveTransfer(id: string, user: AuthUser, code?: string) {
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    if (t.status !== 'En tránsito') throw new BadRequestException('La transferencia no está en tránsito');
    if (!t.toWarehouseId) throw new BadRequestException('La transferencia no tiene bodega destino válida');

    const { from, to: destino } = await this.bodegasDe(t);
    const entreSedes = !!from && !!destino && this.esEntreSedes(from, destino);

    let rastro: string | null = null;
    if (entreSedes) {
      await this.contextoDeFirma(id, 'entrada', user); // valida quién puede firmar
      // Quién puede recibir se sigue comprobando SIEMPRE (la línea de arriba); lo que
      // el ajuste apaga es el código, no el control de quién.
      const { required } = await this.firma.config();
      if (required) {
        if (!code) throw new BadRequestException('Esta recepción va firmada: pide el código y escríbelo para confirmar.');
        rastro = SignatureOtpService.rastro(
          await this.firma.firmar({ userId: user.id, purpose: 'equipment.receive', targetId: id, code }),
        );
      }
    } else {
      // Dentro de la sede no hay código, pero el acotado por sede sí aplica: nadie
      // recibe en una bodega que no es suya.
      const sedes = await sedesDeUsuario(this.prisma, user);
      if (destino) exigirBodegaDeSuSede(sedes, destino);
    }

    return this.prisma.$transaction(async (tx) => {
      const to = await tx.equipmentWarehouse.findUnique({ where: { id: t.toWarehouseId! } });
      if (!to) throw new BadRequestException('La bodega destino ya no existe');
      let received = 0;
      for (const it of t.items) {
        if (!it.equipmentId) continue;
        await tx.equipment.update({ where: { id: it.equipmentId }, data: { warehouseId: to.id, warehouseLegacy: to.legacyId ?? 0, editedAt: new Date() } });
        received++;
      }
      await tx.equipmentTransfer.update({
        where: { id },
        data: { status: 'Recibida', receivedById: user.id, receivedByName: user.name, receivedAt: new Date(), receivedSignature: rastro },
      });
      return { id, status: 'Recibida', received, firmada: !!rastro };
    });
  }

  /** Rechaza una solicitud pendiente (no mueve equipos). Reservado a inventario. */
  async rejectTransfer(id: string, user: AuthUser, reason?: string) {
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    if (t.status !== 'Pendiente') throw new BadRequestException('Solo se puede rechazar una solicitud pendiente');
    await this.prisma.equipmentTransfer.update({
      where: { id },
      data: { status: 'Rechazada', approvedById: user.id, approvedByName: user.name, approvedAt: new Date(), rejectReason: reason?.trim() || null },
    });
    return { id, status: 'Rechazada' };
  }

  /**
   * Bodegas de equipos con conteo.
   *
   * Un técnico de campo no ve las 12 bodegas de la empresa: ve UNA sola, la de los
   * equipos que están a su nombre (2026-07-31). No es una bodega de verdad —el
   * legacy nunca tuvo bodega por técnico, sólo por sede— sino la que corresponde a
   * `Equipment.assignedRaw` = su username, que es el único vínculo equipo↔técnico
   * que existe. Se devuelve con la misma forma que las reales para que la pantalla
   * y el detalle (`/network/equipment`, que aplica el mismo recorte) no tengan que
   * saber la diferencia.
   */
  async equipmentWarehouses(user?: AuthUser) {
    if (esTecnicoDeCampo(user)) {
      const ficha = await fichaDelUsuario(this.prisma, user!);
      const claves = ficha ? clavesDe(ficha) : [];
      const equipment = claves.length
        ? await this.prisma.equipment.count({ where: { assignedRaw: { in: claves, mode: 'insensitive' } } })
        : 0;
      return [{
        id: ficha?.id ?? 'sin-ficha',
        name: 'Mis equipos',
        description: ficha
          ? 'Equipos que están a tu nombre'
          : 'Tu usuario no está ligado a una ficha de empleado: pídele a administración que revise tu correo en Empleados.',
        equipment,
      }];
    }
    const rows = await this.prisma.equipmentWarehouse.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { equipment: true } } } });
    return rows.map((w) => ({ id: w.id, name: w.name, description: w.description, equipment: w._count.equipment }));
  }

  /** Ingreso de equipo (alta). */
  async createEquipment(dto: CreateEquipmentDto, user: AuthUser) {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes dar de alta equipos: tu acceso al inventario es de consulta sobre los que tienes asignados.');
    }
    const wh = await this.prisma.equipmentWarehouse.findUnique({ where: { id: dto.warehouseId } });
    if (!wh) throw new NotFoundException('Bodega no encontrada');
    const max = await this.prisma.equipment.aggregate({ _max: { code: true } });
    const code = (max._max.code ?? 999) + 1;
    const eq = await this.prisma.equipment.create({
      data: {
        code, supplierLegacy: 0, warehouseId: wh.id, warehouseLegacy: wh.legacyId ?? 0,
        mac: dto.mac ?? null, serial: dto.serial ?? null, brand: dto.brand ?? null,
        status: dto.status ?? 'Disponible', observation: dto.observation ?? null, arrival: new Date(),
      },
    });
    return { id: eq.id, code: eq.code };
  }

  /** Conexiones (puertos) de una sede. */
  /**
   * Columnas ordenables de la tabla de conexiones. El orden por defecto es
   * NAP + número de puerto, que es como se mira físicamente la caja.
   */
  private static readonly ORDEN_PUERTOS = {
    nap: (dir: 'asc' | 'desc') => [{ nap: { name: dir } }, { port: 'asc' as const }],
    port: 'port',
    status: 'status',
    client: (dir: 'asc' | 'desc') => [
      { subscriber: { firstName: dir } }, { subscriber: { lastName1: dir } },
    ],
  };

  async ports(params: { search?: string; status?: string; napId?: string; branchId?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    // Filtros de alcance (sede/NAP/búsqueda) que aplican también al conteo de ocupación.
    const scope: Prisma.PortWhereInput = {};
    if (params.napId) scope.napId = params.napId;
    if (params.branchId) scope.nap = { is: { branchId: params.branchId } };
    const search = (params.search || '').trim();
    if (search) {
      scope.OR = [
        { nap: { is: { name: { contains: search, mode: 'insensitive' } } } },
        { subscriber: { is: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName1: { contains: search, mode: 'insensitive' } }] } } },
      ];
    }
    // El estado filtra la tabla, pero NO el conteo (así siempre se ve el split ocupados/libres del alcance).
    const where: Prisma.PortWhereInput = params.status ? { ...scope, status: params.status } : scope;
    const [rows, total, ocupados, libres] = await Promise.all([
      this.prisma.port.findMany({ where, orderBy: orden(params, NetworkWriteService.ORDEN_PUERTOS, [{ napId: 'asc' }, { port: 'asc' }]), skip: (page - 1) * pageSize, take: pageSize, include: { nap: true, subscriber: { select: { id: true, firstName: true, lastName1: true, companyName: true, fullName: true, abonado: true } } } }),
      this.prisma.port.count({ where }),
      this.prisma.port.count({ where: { ...scope, status: 'Ocupado' } }),
      this.prisma.port.count({ where: { ...scope, status: 'Disponible' } }),
    ]);
    return {
      items: rows.map((p) => ({
        id: p.id, port: p.port, status: p.status, nap: p.nap?.name ?? null,
        client: subName(p.subscriber), subscriberId: p.subscriber?.id ?? null, abonado: p.subscriber?.abonado ?? null, detail: p.detail,
      })),
      counts: { ocupados, libres, scope: ocupados + libres },
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Lista slim de NAPs (id + nombre) para selects/combobox, opcionalmente por sede. */
  async napOptions(branchId?: string) {
    const where: Prisma.NapWhereInput = branchId ? { branchId } : {};
    const rows = await this.prisma.nap.findMany({ where, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    return rows.map((n) => ({ id: n.id, name: n.name }));
  }

  async assignPort(id: string, dto: AssignPortDto) {
    const [port, sub] = await Promise.all([
      this.prisma.port.findUnique({ where: { id } }),
      this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true, legacyId: true } }),
    ]);
    if (!port) throw new NotFoundException('Puerto no encontrado');
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    await this.prisma.port.update({ where: { id }, data: { subscriberId: sub.id, assignedLegacy: sub.legacyId ?? 0, status: 'Ocupado' } });
    return { id, status: 'Ocupado' };
  }
  async freePort(id: string) {
    const port = await this.prisma.port.findUnique({ where: { id } });
    if (!port) throw new NotFoundException('Puerto no encontrado');
    await this.prisma.port.update({ where: { id }, data: { subscriberId: null, assignedLegacy: 0, status: 'Disponible' } });
    return { id, status: 'Disponible' };
  }

  /** Alta de caja NAP: crea la NAP y genera sus puertos (todos disponibles). */
  async createNap(dto: CreateNapDto) {
    const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    let vlan: { id: string; legacyId: number; branchId: string | null } | null = null;
    if (dto.vlanId) {
      vlan = await this.prisma.vlan.findUnique({ where: { id: dto.vlanId }, select: { id: true, legacyId: true, branchId: true } });
      if (!vlan) throw new NotFoundException('VLAN no encontrada');
      if (vlan.branchId && vlan.branchId !== branch.id) throw new BadRequestException('La VLAN no pertenece a la sede seleccionada');
    }
    const name = dto.name.trim();
    const dup = await this.prisma.nap.findFirst({ where: { branchId: branch.id, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (dup) throw new BadRequestException('Ya existe una NAP con ese nombre en la sede');

    return this.prisma.$transaction(async (tx) => {
      const [napMax, portMax] = await Promise.all([
        tx.nap.aggregate({ _max: { legacyId: true } }),
        tx.port.aggregate({ _max: { legacyId: true } }),
      ]);
      const legacyId = (napMax._max.legacyId ?? 0) + 1;
      const nap = await tx.nap.create({
        data: {
          legacyId, branchId: branch.id, sedeLegacy: branch.legacyId ?? 0,
          vlanId: vlan?.id ?? null, vlanLegacy: vlan?.legacyId ?? 0,
          name, portCount: dto.portCount, address: dto.address?.trim() ?? '',
          gpsLat: dto.gpsLat?.trim() || null, gpsLng: dto.gpsLng?.trim() || null,
        },
      });
      let pl = portMax._max.legacyId ?? 0;
      const ports = Array.from({ length: dto.portCount }, (_, i) => ({
        legacyId: ++pl, sedeLegacy: branch.legacyId ?? 0, vlanLegacy: vlan?.legacyId ?? 0,
        napId: nap.id, napLegacy: legacyId, port: i + 1, status: 'Disponible', assignedLegacy: 0, detail: '',
      }));
      await tx.port.createMany({ data: ports });
      return { id: nap.id, name: nap.name, ports: ports.length };
    });
  }

  // --- VLANs (CRUD) ---
  async createVlan(dto: CreateVlanDto) {
    const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    const max = await this.prisma.vlan.aggregate({ _max: { legacyId: true } });
    const v = await this.prisma.vlan.create({
      data: {
        legacyId: (max._max.legacyId ?? 0) + 1, branchId: branch.id, sedeLegacy: branch.legacyId ?? 0,
        vlan: dto.vlan, detail: dto.detail.trim(), olt: dto.olt ?? null, tray: dto.tray ?? null, oltPort: dto.oltPort ?? null,
      },
    });
    return { id: v.id, vlan: v.vlan, detail: v.detail };
  }
  async updateVlan(id: string, dto: CreateVlanDto) {
    const v = await this.prisma.vlan.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('VLAN no encontrada');
    // La sede sólo se puede mover mientras la VLAN esté vacía: si ya tiene NAPs
    // colgando, cambiarla dejaría esas NAPs con una VLAN de otra sede (que es
    // justo lo que createNap se niega a hacer).
    let branchData: { branchId: string; sedeLegacy: number } | undefined;
    if (dto.branchId && dto.branchId !== v.branchId) {
      const naps = await this.prisma.nap.count({ where: { vlanId: id } });
      if (naps > 0) throw new BadRequestException(`No se puede cambiar de sede: la VLAN tiene ${naps} NAP(s) asociada(s).`);
      const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId } });
      if (!branch) throw new NotFoundException('Sede no encontrada');
      branchData = { branchId: branch.id, sedeLegacy: branch.legacyId ?? 0 };
    }
    const upd = await this.prisma.vlan.update({
      where: { id },
      data: { vlan: dto.vlan, detail: dto.detail.trim(), olt: dto.olt ?? null, tray: dto.tray ?? null, oltPort: dto.oltPort ?? null, ...branchData },
    });
    return { id: upd.id, vlan: upd.vlan, detail: upd.detail };
  }
  async deleteVlan(id: string) {
    const naps = await this.prisma.nap.count({ where: { vlanId: id } });
    if (naps > 0) throw new BadRequestException(`No se puede eliminar: la VLAN tiene ${naps} NAP(s) asociada(s).`);
    await this.prisma.vlan.delete({ where: { id } });
    return { id, deleted: true };
  }

  // --- NAP editar / eliminar ---
  async updateNap(id: string, dto: UpdateNapDto) {
    const nap = await this.prisma.nap.findUnique({ where: { id } });
    if (!nap) throw new NotFoundException('NAP no encontrada');
    let vlanLegacy = nap.vlanLegacy;
    if (dto.vlanId !== undefined) {
      const v = dto.vlanId ? await this.prisma.vlan.findUnique({ where: { id: dto.vlanId }, select: { legacyId: true } }) : null;
      vlanLegacy = v?.legacyId ?? 0;
    }
    const upd = await this.prisma.nap.update({
      where: { id },
      data: {
        name: dto.name?.trim() ?? nap.name, address: dto.address?.trim() ?? nap.address,
        gpsLat: dto.gpsLat?.trim() ?? nap.gpsLat, gpsLng: dto.gpsLng?.trim() ?? nap.gpsLng,
        vlanId: dto.vlanId !== undefined ? (dto.vlanId || null) : undefined, vlanLegacy,
      },
    });
    return { id: upd.id, name: upd.name };
  }
  async deleteNap(id: string) {
    const used = await this.prisma.port.count({ where: { napId: id, status: { not: 'Disponible' } } });
    if (used > 0) throw new BadRequestException(`No se puede eliminar: la NAP tiene ${used} puerto(s) ocupado(s).`);
    await this.prisma.$transaction(async (tx) => {
      await tx.port.deleteMany({ where: { napId: id } });
      await tx.nap.delete({ where: { id } });
    });
    return { id, deleted: true };
  }

  // --- Asignar / desasignar equipo a cliente ---
  async assignEquipmentToSubscriber(equipmentId: string, dto: AssignEquipmentSubDto) {
    const eq = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!eq) throw new NotFoundException('Equipo no encontrado');
    const sub = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true, legacyId: true } });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: {
        subscriberId: dto.subscriberId, status: 'Asignado', editedAt: new Date(),
        // El mismo dueño en la casilla del legacy (`equipos.asignado`). `editedAt` no
        // basta: el writeback empuja `assignedRaw` y acto seguido suelta el blindaje,
        // así que sin esto la ida devolvía el equipo a "sin dueño" en la pasada
        // siguiente. Ver la misma regla en `EquipoReservaService` y `assignEquipment`.
        ...(sub.legacyId == null ? {} : { assignedRaw: String(sub.legacyId) }),
        // Deja de ser una reserva: esto ya es la entrega.
        reservedTicketId: null,
        // Vuelve a estar instalado: la fecha de la devolución anterior ya no habla
        // de este equipo (si no, en inventario figuraría a la vez "en casa de un
        // cliente" y "devuelto el…").
        returnedAt: null,
        installType: dto.installType ?? eq.installType, port: dto.port ?? eq.port,
        vlan: dto.vlan ?? eq.vlan, meters: dto.meters ?? eq.meters, master: dto.master ?? eq.master,
      },
    });
    return { id: equipmentId, subscriberId: dto.subscriberId, assigned: true };
  }
  async unassignEquipment(equipmentId: string) {
    const eq = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!eq) throw new NotFoundException('Equipo no encontrado');
    await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: {
        subscriberId: null, assignedRaw: null, status: 'Disponible', editedAt: new Date(),
        reservedTicketId: null,
        // Soltar desde inventario también es "el equipo dejó de estar en casa de un
        // cliente": queda fechado hoy. Aquí no se pregunta el día (la devolución con
        // fecha elegible es la de la ficha del cliente), y si el equipo ya estaba
        // libre no se inventa ninguna.
        ...(eq.subscriberId ? { returnedAt: hoyEnColombia() } : {}),
      },
    });
    return { id: equipmentId, unassigned: true };
  }

  /**
   * Corrige los datos de un equipo: marca, MAC, serial, estado y observación.
   *
   * - Sella `editedAt`: sin eso la próxima pasada del sync repone lo del legacy, y con
   *   él el writeback de inventario lleva el cambio allá.
   * - El estado sólo se elige entre los manuales, y no se toca mientras el equipo esté
   *   reservado para una orden (lo suelta o confirma la propia reserva).
   * - No deja poner un serial que ya tenga OTRO equipo: la autenticación de la ONU y
   *   la reserva identifican el equipo por serial, y dos iguales la confunden.
   */
  async updateEquipment(equipmentId: string, dto: UpdateEquipmentDto, user: AuthUser) {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes editar equipos: tu acceso al inventario es de consulta sobre los que tienes asignados.');
    }
    const eq = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!eq) throw new NotFoundException('Equipo no encontrado');

    const limpio = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
    const nuevo = {
      brand: limpio(dto.brand), mac: limpio(dto.mac), serial: limpio(dto.serial),
      status: limpio(dto.status), observation: limpio(dto.observation),
    };
    const data: Prisma.EquipmentUpdateInput = {};
    for (const campo of Object.keys(nuevo) as (keyof typeof nuevo)[]) {
      const v = nuevo[campo];
      if (v !== undefined && v !== (eq[campo] ?? null)) data[campo] = v;
    }
    if (!Object.keys(data).length) return { id: eq.id, code: eq.code, cambios: 0 };

    if ('status' in data) {
      if ((eq.status ?? '').toLowerCase() === 'reservado' || eq.reservedTicketId) {
        throw new BadRequestException('El equipo está reservado para una orden: su estado no se cambia a mano.');
      }
      if (!ESTADOS_EQUIPO_EDITABLES.includes(String(data.status))) {
        throw new BadRequestException(`Estado no válido. Elige uno de: ${ESTADOS_EQUIPO_EDITABLES.join(', ')}.`);
      }
    }

    if ('serial' in data && data.serial) {
      const sn = String(data.serial).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (sn.length >= 6) {
        const otro = await this.prisma.$queryRaw<{ code: number }[]>`
          SELECT code FROM "Equipment"
           WHERE id <> ${eq.id}
             AND upper(regexp_replace(coalesce(serial, ''), '[^A-Za-z0-9]', '', 'g')) = ${sn}
           LIMIT 1`;
        if (otro.length) throw new BadRequestException(`Ese serial ya lo tiene el equipo #${otro[0].code}.`);
      }
    }

    // Un equipo en Disponible/Bueno/Malo/Depurado ya no está en casa de nadie. Antes
    // se cambiaba solo el estado y el dueño seguía puesto (2026-09-15, equipo 311071):
    // la ficha lo enseñaba a nombre del cliente viejo, su puerto NAP seguía "Ocupado"
    // y al entregárselo a otro el modal respondía "la MAC ya está asignada a otro
    // cliente". Se suelta como en la devolución (`returnEquipment`), sin mover de bodega.
    const dueño = 'status' in data && eq.subscriberId ? eq.subscriberId : null;
    if (!dueño) {
      await this.prisma.equipment.update({ where: { id: eq.id }, data: { ...data, editedAt: new Date() } });
      this.logger.log(`Equipo #${eq.code} editado por ${user?.email ?? 'sistema'}: ${Object.keys(data).join(', ')}`);
      return { id: eq.id, code: eq.code, cambios: Object.keys(data).length };
    }

    const restantes = await this.prisma.equipment.findMany({
      where: { subscriberId: dueño, id: { not: eq.id } },
      select: { mac: true, port: true },
      orderBy: { arrival: 'desc' },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.equipment.update({
        where: { id: eq.id },
        data: {
          ...data,
          subscriber: { disconnect: true }, assignedRaw: null, installType: null, port: null, vlan: null, nat: null,
          returnedAt: hoyEnColombia(), editedAt: new Date(),
        },
      });
      // `equipos.puerto` es el id de la FILA del puerto (`Port.legacyId`), no su número.
      if (eq.port != null && !restantes.some((r) => r.port === eq.port)) {
        await tx.port.updateMany({
          where: { subscriberId: dueño, legacyId: eq.port },
          data: { subscriberId: null, assignedLegacy: 0, status: 'Disponible' },
        });
      }
      await tx.subscriber.update({
        where: { id: dueño },
        data: { macEquipo: restantes.find((r) => r.mac?.trim())?.mac?.trim() ?? 'sin asignar' },
      });
      await tx.subscriberNote.create({
        data: {
          subscriberId: dueño,
          body: `Equipo código ${eq.code}${eq.mac ? ` · MAC ${eq.mac}` : ''} marcado "${data.status}" desde el inventario: deja de estar a nombre del cliente.`,
          authorName: user?.name || user?.email || 'sistema',
        },
      });
    });
    // Fuera de la casa del cliente ⇒ fuera de la OLT (en segundo plano, ver `OnuAlDevolverService`).
    void this.onuAlDevolver?.desautenticar({
      serial: eq.serial, code: eq.code, subscriberId: dueño, motivo: `Marcado "${data.status}" en el inventario`, user,
    });
    this.logger.log(`Equipo #${eq.code} editado por ${user?.email ?? 'sistema'}: ${Object.keys(data).join(', ')} · soltado del abonado ${dueño}`);
    return { id: eq.id, code: eq.code, cambios: Object.keys(data).length, soltado: true };
  }

  // ── Pools de IP (ips_users_mk) ──────────────────────────────────────────────
  // Paridad legacy `Mikrotiks::guardar_configuracion` (Mikrotiks.php:250-289) y
  // `Mikrotiks::set_default_ips_user` (:66-70). Nexus solo había migrado la lectura:
  // la pantalla mostraba los pools y no dejaba tocar ninguno.
  //
  // Se replica lo que el legacy hace, y SOLO eso:
  //   · crear, editar y marcar predeterminado,
  //   · el `defecto` es POR SEDE (uno solo por sede),
  //   · al crear el primer pool de una sede, queda predeterminado automáticamente.
  // NO se añade borrado: el legacy no lo tiene (verificado, no hay ningún DELETE
  // sobre `ips_users_mk`), y estos pools los referencian los perfiles PPPoE de los
  // abonados — borrar uno dejaría clientes apuntando a un pool inexistente.

  /** Normaliza la lista de perfiles al formato del legacy: separados por coma. */
  private normProfiles(raw?: string): string {
    return (raw ?? '')
      .split(/[,;\n]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .join(',');
  }

  private async resolveSede(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, legacyId: true, name: true },
    });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    if (branch.legacyId == null) throw new BadRequestException('La sede no tiene código legacy: no se puede asociar el pool');
    return branch;
  }

  async createIpPool(dto: CreateIpPoolDto) {
    const branch = await this.resolveSede(dto.branchId);
    const name = dto.name.trim();
    const dup = await this.prisma.ipUserMk.findFirst({
      where: { sedeLegacy: branch.legacyId!, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('Ya existe un pool con ese nombre en la sede');

    return this.prisma.$transaction(async (tx) => {
      // Paridad legacy (Mikrotiks.php:259-261): el primer pool de una sede queda
      // predeterminado solo. Si no, la sede se quedaría sin pool por defecto y el
      // aprovisionamiento no sabría cuál usar.
      const yaHay = await tx.ipUserMk.count({ where: { sedeLegacy: branch.legacyId! } });
      const max = await tx.ipUserMk.aggregate({ _max: { legacyId: true } });
      return tx.ipUserMk.create({
        data: {
          legacyId: (max._max.legacyId ?? 0) + 1,
          name,
          ipLocal: dto.ipLocal.trim(),
          ipRemote: dto.ipRemote.trim(),
          tech: (dto.tech ?? '').trim(),
          sedeLegacy: branch.legacyId!,
          isDefault: yaHay === 0,
          profiles: this.normProfiles(dto.profiles),
        },
      });
    });
  }

  async updateIpPool(id: string, dto: UpdateIpPoolDto) {
    const pool = await this.prisma.ipUserMk.findUnique({ where: { id } });
    if (!pool) throw new NotFoundException('Pool de IP no encontrado');

    let sedeLegacy = pool.sedeLegacy;
    if (dto.branchId) sedeLegacy = (await this.resolveSede(dto.branchId)).legacyId!;

    const name = dto.name?.trim() ?? pool.name;
    const dup = await this.prisma.ipUserMk.findFirst({
      where: { sedeLegacy, name: { equals: name, mode: 'insensitive' }, id: { not: id } },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('Ya existe un pool con ese nombre en la sede');

    return this.prisma.ipUserMk.update({
      where: { id },
      data: {
        name,
        sedeLegacy,
        // `undefined` = no tocar; así un PATCH parcial no borra lo que no manda.
        ipLocal: dto.ipLocal?.trim(),
        ipRemote: dto.ipRemote?.trim(),
        tech: dto.tech?.trim(),
        profiles: dto.profiles === undefined ? undefined : this.normProfiles(dto.profiles),
      },
    });
  }

  /**
   * Marca el pool como predeterminado de SU sede. Paridad legacy
   * `set_default_ips_user`: primero limpia el de la sede, luego lo pone en este.
   * En una transacción — el legacy lo hacía en dos UPDATE sueltos y un fallo entre
   * ambos dejaba a la sede sin ningún predeterminado.
   */
  async setDefaultIpPool(id: string) {
    const pool = await this.prisma.ipUserMk.findUnique({ where: { id }, select: { id: true, sedeLegacy: true } });
    if (!pool) throw new NotFoundException('Pool de IP no encontrado');
    await this.prisma.$transaction([
      this.prisma.ipUserMk.updateMany({ where: { sedeLegacy: pool.sedeLegacy }, data: { isDefault: false } }),
      this.prisma.ipUserMk.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return { id, isDefault: true };
  }
}
