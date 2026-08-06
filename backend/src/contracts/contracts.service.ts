import { BadRequestException, NotFoundException } from '../core/http/errores';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/current-user.decorator';
import { exigirSedeSuscriptor } from '../common/sede-scope';

/** Carpeta donde ya viven los adjuntos del cliente; firma y huella van con ellos. */
const UPLOAD_ROOT = join(process.cwd(), 'uploads', 'subscribers');

/**
 * Las cláusulas creadas aquí toman legacyId desde 900 para no chocar nunca con las
 * del legacy (que hoy van del 1 al 5) si alguien agrega una allá. Misma idea que
 * los consecutivos de factura particionados.
 */
const LEGACY_ID_NEXUS_DESDE = 900;

/** Tope de la firma capturada en el navegador: un PNG de tableta pesa ~30 KB. */
const MAX_FIRMA_BYTES = 2 * 1024 * 1024;

/**
 * `products.pid = 27` = "Television" ($22.059 + 19%). La vista del anexo lo busca
 * por ese id fijo, no por nombre; se respeta para que la mensualidad impresa sea
 * la misma que calcula el legacy.
 */
const PRODUCTO_TV_LEGACY = 27;

type ClausulaDto = {
  nombre: string;
  meses: number;
  vTotal: number;
  valores: number[];
  activa?: boolean;
};

/**
 * Contratos de los clientes: catálogo de cláusulas de permanencia, datos para el
 * PDF y las dos pruebas de aceptación (firma y huella).
 *
 * Por qué existe como módulo aparte y no como dos métodos en SubscribersService:
 * el contrato cruza cuatro cosas que ninguna otra pantalla cruza junta —el abonado,
 * su plan facturable, la cláusula de permanencia y los archivos de firma—, y esa
 * mezcla es la que hace que el documento sirva como prueba.
 */
export class ContractsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Catálogo de cláusulas ────────────────────────────────────────────────

  async clausulas(soloActivas = false) {
    const rows = await this.prisma.clausula.findMany({
      where: soloActivas ? { activa: true } : {},
      orderBy: [{ activa: 'desc' }, { meses: 'asc' }, { nombre: 'asc' }],
    });
    // Cuántos abonados usa cada una: sin esto no se puede decidir si una cláusula
    // se puede desactivar o si borrarla dejaría contratos sin permanencia.
    const uso = await this.prisma.subscriber.groupBy({
      by: ['clausula'],
      where: { clausula: { not: null } },
      _count: { _all: true },
    });
    const porLegacy = new Map(uso.map((u) => [u.clausula, u._count._all]));
    return rows.map((c) => ({
      id: c.id,
      legacyId: c.legacyId,
      nombre: c.nombre,
      meses: c.meses,
      vTotal: c.vTotal,
      valores: c.valores,
      activa: c.activa,
      abonados: c.legacyId != null ? (porLegacy.get(c.legacyId) ?? 0) : 0,
      delLegacy: c.legacyId != null && c.legacyId < LEGACY_ID_NEXUS_DESDE,
    }));
  }

  async crearClausula(dto: ClausulaDto) {
    this.validar(dto);
    const max = await this.prisma.clausula.aggregate({ _max: { legacyId: true } });
    const siguiente = Math.max(LEGACY_ID_NEXUS_DESDE, (max._max.legacyId ?? 0) + 1);
    return this.prisma.clausula.create({
      data: {
        legacyId: siguiente,
        nombre: dto.nombre.trim(),
        meses: dto.meses,
        vTotal: dto.vTotal,
        valores: dto.valores,
        activa: dto.activa ?? true,
      },
    });
  }

  async actualizarClausula(id: string, dto: Partial<ClausulaDto>) {
    const actual = await this.prisma.clausula.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException('Cláusula no encontrada');
    const mezcla = { ...actual, ...dto } as ClausulaDto;
    this.validar(mezcla);
    return this.prisma.clausula.update({
      where: { id },
      data: {
        nombre: mezcla.nombre.trim(),
        meses: mezcla.meses,
        vTotal: mezcla.vTotal,
        valores: mezcla.valores,
        activa: dto.activa ?? actual.activa,
      },
    });
  }

  /**
   * Borrar una cláusula que ya está en contratos firmados dejaría esos contratos
   * sin la tabla de permanencia que la ley obliga a mostrar. Con abonados detrás
   * solo se puede desactivar (deja de ofrecerse, sigue imprimiéndose).
   */
  async eliminarClausula(id: string) {
    const c = await this.prisma.clausula.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Cláusula no encontrada');
    const enUso = c.legacyId == null ? 0 : await this.prisma.subscriber.count({ where: { clausula: c.legacyId } });
    if (enUso > 0) {
      throw new BadRequestException(
        `${enUso} abonado(s) tienen esta cláusula en su contrato. Desactívala en vez de borrarla.`,
      );
    }
    await this.prisma.clausula.delete({ where: { id } });
    return { ok: true };
  }

  private validar(dto: ClausulaDto) {
    if (!dto.nombre?.trim()) throw new BadRequestException('La cláusula necesita un nombre');
    if (!Number.isInteger(dto.meses) || dto.meses < 1 || dto.meses > 12) {
      throw new BadRequestException('Los meses de permanencia van de 1 a 12');
    }
    if (!Array.isArray(dto.valores) || dto.valores.length !== dto.meses) {
      throw new BadRequestException(`Faltan valores: la cláusula es de ${dto.meses} meses y hay ${dto.valores?.length ?? 0} valores`);
    }
    if (dto.valores.some((v) => !Number.isFinite(v) || v < 0)) {
      throw new BadRequestException('Los valores de retiro anticipado no pueden ser negativos');
    }
  }

  /** Cláusula de un abonado (resuelta por el número legacy que guarda `Subscriber.clausula`). */
  private async clausulaDe(numero: number | null) {
    if (numero == null) return null;
    const c = await this.prisma.clausula.findUnique({ where: { legacyId: numero } });
    return c ? { nombre: c.nombre, meses: c.meses, vTotal: c.vTotal, valores: c.valores } : null;
  }

  // ── Datos del contrato (con la forma que esperan las vistas del legacy) ──

  /**
   * Servicios contratados, portado de `Customers_model::servicios_detail`.
   *
   * El legacy NO guarda el servicio en el abonado: lo deduce recorriendo sus
   * facturas de la más nueva a la más vieja y quedándose con la primera que
   * "vale" —ni fija, ni nota, ni una de afiliación o traslado—. Se replica igual
   * porque de aquí salen el plan y la mensualidad que se imprimen en el contrato:
   * calcularlo de otra manera cambiaría las cifras del documento.
   */
  private async serviciosDetail(subscriberId: string) {
    const facturas = await this.prisma.subInvoice.findMany({
      where: { subscriberId },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      select: {
        tid: true, kind: true, ron: true, status: true, subtotal: true, total: true,
        itemsCount: true, invoiceDate: true, serviceTv: true, serviceCombo: true,
        puntos: true, estadoTv: true, estadoCombo: true,
        items: { select: { productName: true, description: true } },
      },
    });

    const servicios: Record<string, any> = {
      television: 'no', combo: 'no', puntos: 'no', estado: 'Inactivo',
      estado_combo: null, estado_tv: null, paquete: '', tipo_retencion: null,
    };
    const vacio = (v?: string | null) => !v || v === 'no' || v === '' || v === '-';

    for (const f of facturas) {
      let valida = false;
      if (!vacio(f.serviceCombo) && f.kind !== 'FIJA') {
        if (f.estadoCombo == null) {
          valida = true;
          servicios.combo = f.serviceCombo;
        } else {
          servicios.estado_combo = f.estadoCombo;
          servicios.paquete = f.serviceCombo;
        }
      }
      if (!vacio(f.serviceTv) && f.kind !== 'FIJA') {
        if (f.estadoTv == null) {
          valida = true;
          servicios.television = f.serviceTv;
        } else {
          servicios.estado_tv = f.estadoTv;
        }
        servicios.puntos = f.puntos;
      }
      if (f.ron) valida = true;

      // Una factura de afiliación o traslado no dice qué tiene contratado el
      // abonado: es un cobro puntual. El legacy la descarta y sigue buscando.
      const esAfiliacionOTraslado = f.items.some((it) =>
        /afiliacion|traslado/i.test(`${it.productName ?? ''} ${it.description ?? ''}`));
      if (esAfiliacionOTraslado) valida = false;
      if (f.kind === 'FIJA' || f.kind === 'NOTA_CREDITO' || f.kind === 'NOTA_DEBITO') valida = false;

      if (valida) {
        servicios.tid = f.tid;
        servicios.status_inv = f.status;
        servicios.subtotal = Number(f.subtotal ?? 0);
        servicios.total = Number(f.total ?? 0);
        servicios.items = f.itemsCount;
        servicios.invoicedate = f.invoiceDate;
        servicios.estado = f.ron;
        if (f.ron === 'SUSPENDIDO') {
          servicios.television = 'no';
          servicios.combo = 'no';
          servicios.estado = 'Suspendido';
        } else if (servicios.television !== 'no' || servicios.combo !== 'no') {
          if (servicios.television !== 'no' && vacio(f.serviceTv)) {
            servicios.television = 'no';
            servicios.estado = 'Television suspendida';
          }
          if (servicios.combo !== 'no' && vacio(f.serviceCombo)) {
            servicios.combo = 'no';
            servicios.estado = 'Internet suspendido';
          }
        }
        break;
      }
    }

    // Ajustes que el legacy hace en el controlador antes de pintar la vista
    // (`Customers::printpdf`), no en el modelo.
    if (servicios.estado_combo != null) servicios.combo = servicios.paquete;
    if (servicios.estado_tv != null) servicios.television = 'Television';
    return servicios;
  }

  /**
   * El sobre de datos que reciben las vistas del legacy: `$details` con nombres
   * de columna de `customers`, más los catálogos que la vista resuelve aparte.
   *
   * Lo único que NO se pasa igual que allá es el barrio: el legacy imprime en
   * "Dirección de servicio" el ID del barrio (un número), porque la vista muestra
   * `customers.barrio` tal cual. Aquí va el NOMBRE. Es la misma casilla del mismo
   * documento con el dato que le corresponde.
   */
  async datosContratoLegacy(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      include: { equipment: { orderBy: { arrival: 'desc' }, take: 1 } },
    });
    if (!s) throw new NotFoundException('Cliente no encontrado');

    const [dep, ciu, loc, bar, empresa] = await Promise.all([
      s.departmentRef ? this.prisma.department.findFirst({ where: { legacyId: Number(s.departmentRef) }, select: { name: true } }) : null,
      s.cityRef ? this.prisma.city.findFirst({ where: { legacyId: Number(s.cityRef) }, select: { name: true } }) : null,
      s.localityRef ? this.prisma.locality.findFirst({ where: { legacyId: Number(s.localityRef) }, select: { name: true } }) : null,
      s.neighborhood ? this.prisma.neighborhood.findFirst({ where: { legacyId: Number(s.neighborhood) }, select: { name: true } }) : null,
      this.prisma.companyInfo.findFirst(),
    ]);

    const servicios = await this.serviciosDetail(id);

    // Los precios salen de `Material`, que es el espejo de `products` del legacy
    // (de ahí los toma la vista para calcular la mensualidad con IVA). Se buscan
    // el paquete de TV (pid 27 y por nombre) y el plan de internet.
    const nombres = [servicios.television, servicios.combo].filter((n) => n && n !== 'no') as string[];
    const materiales = await this.prisma.material.findMany({
      where: { OR: [{ legacyId: PRODUCTO_TV_LEGACY }, ...(nombres.length ? [{ name: { in: nombres } }] : [])] },
      select: { legacyId: true, name: true, price: true, taxRate: true },
    });
    const productos = materiales.map((m) => ({
      pid: m.legacyId,
      product_name: m.name,
      product_price: Number(m.price ?? 0),
      taxrate: Number(m.taxRate ?? 0),
    }));

    const c = await this.prisma.clausula.findUnique({ where: { legacyId: s.clausula ?? -1 } }).catch(() => null);
    // La vista imprime SIEMPRE los 12 meses: las cláusulas cortas se rellenan con
    // ceros igual que en la tabla `clausula` del legacy.
    const meses: Record<string, number> = {};
    for (let i = 1; i <= 12; i++) meses[`mes${i}`] = c?.valores[i - 1] ?? 0;

    const nom = (s.nomenclature ?? {}) as Record<string, unknown>;
    const eq = s.equipment[0];
    const dOnly = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    const txt = (v: unknown) => (v == null ? '' : String(v));

    return {
      config: { ctitle: empresa?.name ?? 'VESTEL S.A.S', logo: empresa?.logo ?? '' },
      // Formato de moneda del legacy (app_system.currency + univarsal_api id=4).
      moneda: { simbolo: empresa?.currency ?? '$', decimales: 0, sep_decimal: '', sep_miles: '.' },
      details: {
        // El pie del PDF y la búsqueda del equipo usan `customers.id`; para un
        // abonado creado aquí (sin legacyId) se usa su número de abonado.
        id: s.legacyId ?? s.abonado,
        abonado: s.abonado,
        name: txt(s.firstName), dosnombre: txt(s.secondName),
        unoapellido: txt(s.lastName1), dosapellido: txt(s.lastName2),
        company: txt(s.companyName), tipo_documento: txt(s.docType), documento: txt(s.docNumber),
        email: txt(s.email), celular: txt(s.phone1), celular2: txt(s.phone2),
        f_contrato: dOnly(s.contractDate), estrato: txt(s.estrato), suscripcion: txt(s.suscripcion),
        barrio: bar?.name ?? txt(s.neighborhood),
        dirsuscriptor: txt(s.addressLine),
        nomenclatura: txt(nom.nomenclatura), numero1: txt(nom.numero1), adicionauno: txt(nom.adicionauno),
        numero2: txt(nom.numero2), adicional2: txt(nom.adicional2), numero3: txt(nom.numero3),
        residencia: txt(nom.residencia), referencia: txt(nom.referencia),
        divicion: txt(nom.divicion), divnum1: txt(nom.divnum1),
        divicion2: txt(nom.divicion2), divnum2: txt(nom.divnum2),
        coor1: txt(s.gpsLat), coor2: txt(s.gpsLng),
      },
      departamento: { departamento: dep?.name ?? '' },
      ciudad: { ciudad: ciu?.name ?? '' },
      localidad: { localidad: loc?.name ?? '' },
      barrio: { barrio: bar?.name ?? '' },
      clausula: c
        ? { idcla: c.legacyId, nombre: c.nombre, meses: c.meses, v_total: c.vTotal, ...meses }
        : { idcla: 0, nombre: '', meses: 0, v_total: 0, ...meses },
      servicios,
      productos,
      equipo: eq
        ? {
            serial: txt(eq.serial), marca: txt(eq.brand), mac: txt(eq.mac),
            metros: eq.meters ?? '', accesorios: txt(eq.accessories), asignado: s.legacyId ?? 0,
          }
        : null,
      url_firma: this.rutaSiExiste(id, s.signaturePath),
      url_huella: this.rutaSiExiste(id, s.fingerprintPath),
      abonado: s.abonado,
    };
  }

  /** Ruta absoluta del archivo si está en disco (la vista hace `file_exists`). */
  private rutaSiExiste(id: string, nombre: string | null): string {
    if (!nombre) return '';
    const abs = join(UPLOAD_ROOT, id, nombre);
    return existsSync(abs) ? abs : '';
  }

  // ── Datos del contrato ───────────────────────────────────────────────────

  /** Estado del contrato para la ficha del cliente (sin cargar los binarios). */
  async estado(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        clausula: true, contractDate: true, digitalSignature: true,
        signaturePath: true, signatureAt: true, signatureBy: true,
        fingerprintPath: true, fingerprintAt: true,
      },
    });
    if (!s) throw new NotFoundException('Cliente no encontrado');
    const c = await this.clausulaDe(s.clausula);
    const fin = c && s.contractDate ? new Date(s.contractDate) : null;
    if (fin && c) fin.setUTCMonth(fin.getUTCMonth() + c.meses);
    return {
      contractDate: s.contractDate,
      clausula: c ? { ...c, numero: s.clausula, fin, vigente: fin ? fin.getTime() > Date.now() : null } : null,
      firma: s.signaturePath
        ? { at: s.signatureAt, by: s.signatureBy }
        : null,
      // El flag del legacy sin archivo significa "firmó en el legacy pero el PNG no
      // se importó": se dice, no se hace pasar por firmado aquí.
      firmaLegacySinArchivo: !s.signaturePath && s.digitalSignature,
      huella: s.fingerprintPath ? { at: s.fingerprintAt } : null,
    };
  }

  // ── Firma y huella ───────────────────────────────────────────────────────

  /**
   * Guarda la firma capturada en el navegador (canvas → PNG en base64).
   *
   * Se acepta solo PNG y se comprueba la firma del formato en los bytes, no el
   * prefijo del data URL: el prefijo lo escribe el cliente y no prueba nada.
   */
  async guardarFirma(id: string, dataUrl: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const buf = this.decodificarPng(dataUrl);
    const nombre = `firma-${Date.now()}.png`;
    this.escribir(id, nombre, buf);
    const anterior = (await this.prisma.subscriber.findUnique({ where: { id }, select: { signaturePath: true } }))?.signaturePath;
    await this.prisma.subscriber.update({
      where: { id },
      data: {
        signaturePath: nombre,
        signatureAt: new Date(),
        signatureBy: user?.name ?? user?.email ?? null,
        digitalSignature: true, // el flag que el writeback devuelve al legacy
      },
    });
    if (anterior && anterior !== nombre) this.borrarArchivo(id, anterior);
    return { ok: true };
  }

  /** Huella: llega como archivo (foto o escaneo), ya validada por multer. */
  async guardarHuella(id: string, nombreEnDisco: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const anterior = (await this.prisma.subscriber.findUnique({ where: { id }, select: { fingerprintPath: true } }))?.fingerprintPath;
    await this.prisma.subscriber.update({
      where: { id },
      data: { fingerprintPath: nombreEnDisco, fingerprintAt: new Date() },
    });
    if (anterior && anterior !== nombreEnDisco) this.borrarArchivo(id, anterior);
    return { ok: true };
  }

  async borrarFirma(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({ where: { id }, select: { signaturePath: true } });
    if (s?.signaturePath) this.borrarArchivo(id, s.signaturePath);
    await this.prisma.subscriber.update({
      where: { id },
      data: { signaturePath: null, signatureAt: null, signatureBy: null, digitalSignature: false },
    });
    return { ok: true };
  }

  async borrarHuella(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({ where: { id }, select: { fingerprintPath: true } });
    if (s?.fingerprintPath) this.borrarArchivo(id, s.fingerprintPath);
    await this.prisma.subscriber.update({ where: { id }, data: { fingerprintPath: null, fingerprintAt: null } });
    return { ok: true };
  }

  /** Ruta absoluta de la imagen para servirla, con el alcance por sede ya exigido. */
  async rutaImagen(id: string, cual: 'firma' | 'huella', user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { signaturePath: true, fingerprintPath: true },
    });
    const nombre = cual === 'firma' ? s?.signaturePath : s?.fingerprintPath;
    if (!nombre) throw new NotFoundException(cual === 'firma' ? 'El cliente no tiene firma' : 'El cliente no tiene huella');
    const abs = join(UPLOAD_ROOT, id, nombre);
    if (!existsSync(abs)) throw new NotFoundException('El archivo no está en el servidor');
    return abs;
  }

  // ── Disco ────────────────────────────────────────────────────────────────

  private decodificarPng(dataUrl: string): Buffer {
    const base64 = String(dataUrl || '').replace(/^data:image\/png;base64,/, '');
    if (!base64) throw new BadRequestException('No se recibió la firma');
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_FIRMA_BYTES) throw new BadRequestException('La firma pesa demasiado');
    // \x89PNG\r\n\x1a\n — sin esto entraría cualquier cosa renombrada a .png.
    const magia = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(magia)) {
      throw new BadRequestException('La firma debe ser una imagen PNG');
    }
    return buf;
  }

  private escribir(id: string, nombre: string, buf: Buffer) {
    const dir = join(UPLOAD_ROOT, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, nombre), buf);
  }

  private borrarArchivo(id: string, nombre: string) {
    try { unlinkSync(join(UPLOAD_ROOT, id, nombre)); } catch { /* ya no está */ }
  }

  private async leerArchivo(id: string, nombre: string | null): Promise<Buffer | null> {
    if (!nombre) return null;
    const abs = join(UPLOAD_ROOT, id, nombre);
    try {
      return existsSync(abs) ? await readFile(abs) : null;
    } catch {
      return null;
    }
  }
}
