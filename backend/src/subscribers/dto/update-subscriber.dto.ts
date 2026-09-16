import {
  IsOptional, IsString, MaxLength, MinLength, IsDateString, ValidateIf, IsEmail, IsIn, IsObject, IsInt,
  IsArray, IsBoolean, IsNumber, Min, Max, ArrayMaxSize,
} from 'class-validator';

/** Agregar una nota/observación al cliente. */
export class AddNoteDto {
  @IsString() @MinLength(1) @MaxLength(2000)
  body!: string;
}

/** Tecnologías de instalación (enum Prisma `InstallTech`). */
export const INSTALL_TECHS = ['GPON', 'EPON', 'EOC', 'RADIO', 'FIBRA'] as const;

const KINDS = ['RECURRENTE', 'FIJA', 'NOTA_CREDITO', 'NOTA_DEBITO'];
const RONS = [
  'ACTIVO', 'INSTALAR', 'CORTADO', 'SUSPENDIDO', 'EXONERADO', 'CARTERA', 'COMPROMISO',
  'DEPURADO', 'RETIRADO', 'ANULADO', 'REPORTADO', 'EVENTO', 'DADO_DE_BAJA', 'POR_RETIRAR',
];

/** Editar los campos de cabecera de una factura (no toca montos ni ítems). */
export class UpdateInvoiceDto {
  @IsOptional() @IsDateString()
  invoiceDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  @IsOptional() @IsIn(KINDS)
  kind?: string;

  @IsOptional() @IsIn(RONS)
  ron?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

/** Estados del abonado (enum Prisma `SubscriberStatus`). */
export const SUBSCRIBER_STATUSES = [
  'ACTIVO', 'CARTERA', 'COMPROMISO', 'CORTADO', 'DEPURADO', 'EVENTO', 'EXONERADO',
  'INSTALAR', 'POR_RETIRAR', 'REPORTADO', 'RETIRADO', 'SUSPENDIDO', 'INACTIVO',
] as const;

/** Cambio manual de estado del abonado (administrativo: no toca el router). */
export class ChangeStatusDto {
  @IsIn(SUBSCRIBER_STATUSES as unknown as string[])
  status!: string;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

/** Servicios cuyo estado se puede mover a mano desde la ficha. */
export const SERVICIOS_ESTADO = ['INTERNET', 'TV'] as const;

/** Estados de un servicio (enum Prisma `ServiceStatus`). */
export const SERVICE_STATUSES = ['ACTIVO', 'CORTADO', 'SUSPENDIDO'] as const;

/**
 * Cambio manual del estado de UN servicio del abonado (su internet o su televisión).
 *
 * Es el hermano por servicio de `ChangeStatusDto`: el estado del abonado dice cómo está
 * la cuenta, y esto dice qué está recibiendo. Hacen falta los dos porque no son lo
 * mismo —se puede tener la TV suspendida y el internet navegando— y hasta ahora el
 * segundo sólo se podía mover cerrando una orden.
 */
export class ChangeServiceStatusDto {
  @IsIn(SERVICIOS_ESTADO as unknown as string[])
  servicio!: string;

  @IsIn(SERVICE_STATUSES as unknown as string[])
  estado!: string;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

const CUSTOMER_TYPES = ['Natural', 'Juridico', 'Gubernamental', 'Militar'];
const SUSCRIPCIONES = ['Residencial', 'Corporativo', 'Dedicado'];

/**
 * Campos editables del perfil de un cliente (pasos 1 y 2 del wizard:
 * datos personales + ubicación/dirección). Todos opcionales para el PATCH;
 * "" limpia el campo. La red (Mikrotik) se maneja aparte.
 */
export class UpdateSubscriberDto {
  // ── Paso 1: datos personales ──
  @IsOptional() @IsInt()
  abonado?: number;

  @IsOptional() @IsString() @MaxLength(80)
  firstName?: string;

  @IsOptional() @IsString() @MaxLength(80)
  secondName?: string;

  @IsOptional() @IsString() @MaxLength(80)
  lastName1?: string;

  @IsOptional() @IsString() @MaxLength(80)
  lastName2?: string;

  @IsOptional() @IsString() @MaxLength(200)
  companyName?: string;

  @IsOptional() @IsIn(CUSTOMER_TYPES)
  customerType?: string;

  @IsOptional() @IsString() @MaxLength(20)
  docType?: string;

  @IsOptional() @IsString() @MaxLength(40)
  docNumber?: string;

  @IsOptional() @ValidateIf((o) => o.email !== '' && o.email != null) @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone1?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone2?: string;

  @IsOptional() @ValidateIf((o) => o.birthDate !== '' && o.birthDate != null) @IsDateString()
  birthDate?: string;

  @IsOptional() @IsString() @MaxLength(20)
  estrato?: string;

  @IsOptional() @IsIn(SUSCRIPCIONES)
  suscripcion?: string;

  @IsOptional() @ValidateIf((o) => o.contractDate !== '' && o.contractDate != null) @IsDateString()
  contractDate?: string;

  // ── Paso 2: ubicación / dirección ──
  @IsOptional() @IsString() @MaxLength(20)
  departmentRef?: string;

  @IsOptional() @IsString() @MaxLength(20)
  cityRef?: string;

  @IsOptional() @IsString() @MaxLength(20)
  localityRef?: string;

  @IsOptional() @IsString() @MaxLength(20)
  neighborhood?: string;

  @IsOptional() @IsString() @MaxLength(300)
  addressLine?: string;

  /** {nomenclatura,numero1,adicionauno,numero2,adicional2,numero3,residencia,referencia,divicion,divnum1,divicion2,divnum2} */
  @IsOptional() @IsObject()
  nomenclature?: Record<string, unknown>;

  /**
   * Cláusula de permanencia mínima (número legacy; `null` = sin permanencia).
   * Acepta null a propósito: quitarle la permanencia a un abonado es una decisión
   * que se toma, y sin esto la única forma de expresarla sería omitir el campo,
   * que significa "no lo cambies".
   */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt()
  clausula?: number | null;

  @IsOptional() @IsString() @MaxLength(60)
  gpsLat?: string;

  @IsOptional() @IsString() @MaxLength(60)
  gpsLng?: string;

  @IsOptional() @IsString()
  branchId?: string;

  // --- Conectividad (legacy `create.php`: name_s, contra, perfil, Ipremota, tegnologia).
  // El secret PPP se valida contra duplicados en el servidor (ver SubscribersService).
  @IsOptional() @IsString() @MaxLength(80)
  pppUsername?: string;

  @IsOptional() @IsString() @MaxLength(80)
  pppPassword?: string;

  @IsOptional() @IsString() @MaxLength(60)
  pppProfile?: string;

  @IsOptional() @IsString() @MaxLength(40)
  ipRemote?: string;

  @IsOptional() @IsString() @MaxLength(40)
  ipLocal?: string;

  @IsOptional() @IsString() @MaxLength(40)
  macEquipo?: string;

  @IsOptional() @IsString() @MaxLength(40)
  macOnt?: string;

  /** Comentario del secret (`customers.comentario`): barrio, abonado, VLAN y tecnología. */
  @IsOptional() @IsString() @MaxLength(200)
  netComment?: string;

  /**
   * VLAN por la que navega el abonado. No es una columna: se escribe DENTRO de
   * `netComment` (ver common/net-comment.ts), que es el único sitio donde el legacy
   * la deja apuntada. Acepta null a propósito —quitarle la VLAN a una ficha mal
   * capturada es una corrección legítima— y 0/4095 quedan fuera por reservadas.
   */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(4094)
  vlan?: number | null;

  @IsOptional() @IsIn(INSTALL_TECHS as unknown as string[])
  installTech?: string;
}

/**
 * Crear un cliente nuevo. Mismos campos que el update, pero con los mínimos
 * obligatorios del legacy (1er nombre, celular, correo, nacimiento). El
 * `abonado` se autogenera (max+1) si no viene.
 *
 * Los campos del bloque "alta completa" (planes, provisión, factura y orden) los
 * consume `AltaClienteService`, no `SubscribersService.create`: la fila del
 * abonado se escribe igual que siempre y encima se corre el resto del alta.
 */
export class CreateSubscriberDto extends UpdateSubscriberDto {
  @IsString() @MinLength(1) @MaxLength(80)
  declare firstName: string;

  @IsString() @MinLength(3) @MaxLength(40)
  declare phone1: string;

  @IsEmail()
  declare email: string;

  @IsDateString()
  declare birthDate: string;

  /**
   * Planes del catálogo que contrata (uno por tipo de servicio: internet, TV…).
   * Es lo que fija el perfil/velocidad del router Y lo que factura el cron
   * mensual: sin plan, el abonado nace sin `SubscriberService` y no lo factura
   * nadie. Ver `AltaClienteService.alta`.
   */
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true })
  planIds?: string[];

  /**
   * Combo que contrata, en vez de elegir los planes sueltos. Si viene, MANDA
   * sobre `planIds`: son sus planes al precio del paquete.
   */
  @IsOptional() @IsString()
  bundleId?: string;

  /** Crear el secret PPPoE en el Mikrotik de la sede. Exige `pppUsername`. */
  @IsOptional() @IsBoolean()
  provision?: boolean;

  /** Emitir la factura de afiliación (el producto «Afiliación …», NO la mensualidad). */
  @IsOptional() @IsBoolean()
  firstInvoice?: boolean;

  /**
   * Afiliación que se le cobra: `Material.id` de un producto «Afiliación …».
   * Ausente = la deduce el backend de los servicios contratados (`nombreSugerido`).
   */
  @IsOptional() @IsString()
  affiliationId?: string;

  /**
   * Precio de la afiliación, si no es el del catálogo. 0 = se regala (y entonces no
   * hay factura que emitir, salvo que se cobre instalación aparte).
   */
  @IsOptional() @IsNumber() @Min(0)
  affiliationPrice?: number;

  /** Cargo de instalación aparte, en la misma factura. 0 / ausente = no se cobra. */
  @IsOptional() @IsNumber() @Min(0)
  installCharge?: number;

  /** Abrir la orden de instalación (clase servicio, detalle "Instalacion"). */
  @IsOptional() @IsBoolean()
  installOrder?: boolean;

  /** Técnico al que nace asignada la orden de instalación (texto, como el legacy). */
  @IsOptional() @IsString() @MaxLength(80)
  installAssigned?: string;

  /** Día para el que se agenda la instalación (YYYY-MM-DD). Exige técnico. */
  @IsOptional() @IsDateString()
  installScheduledFor?: string;
}

/** Campos que la pantalla de alta manda para el chequeo previo de duplicados. */
export class CheckDuplicatesDto {
  @IsOptional() @IsString() docNumber?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() pppUsername?: string;
  @IsOptional() @IsString() installTech?: string;
  @IsOptional() @IsString() departmentRef?: string;
  @IsOptional() @IsString() cityRef?: string;
  @IsOptional() @IsString() localityRef?: string;
  @IsOptional() @IsString() neighborhood?: string;
  @IsOptional() @IsString() addressLine?: string;
}

/**
 * Estados con los que un equipo vuelve del cliente (mismos tres del legacy:
 * `views/customers/equipos.php`, modal "Devolucion de equipo").
 */
export const RETURN_EQUIPMENT_STATUSES = ['Bueno', 'Malo', 'Depurado'] as const;

/**
 * Devolución de un equipo que estaba instalado en casa del cliente.
 *
 * `warehouseId` es opcional a propósito: con estado "Depurado" el equipo va SIEMPRE
 * a la bodega de depurados (no vuelve al stock utilizable) y con los otros dos, si
 * no se elige, el servidor lo manda a la bodega de la sede del cliente. El motivo
 * es obligatorio —al revés que el legacy, donde se podía dejar vacío— porque es lo
 * único que explica después por qué ese equipo dejó de estar instalado.
 */
export class ReturnEquipmentDto {
  @IsIn(RETURN_EQUIPMENT_STATUSES as unknown as string[])
  status!: string;

  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;

  @IsOptional() @IsString()
  warehouseId?: string;

  /**
   * Día en que se recogió el equipo. Por defecto hoy; se puede fechar atrás
   * porque el técnico casi siempre trae el equipo días antes de que alguien
   * registre la devolución, y la fecha que importa es la de la recogida, no la
   * del tecleo. El servidor no acepta fechas futuras (ver `returnEquipment`).
   */
  @IsOptional() @IsDateString()
  returnedAt?: string;

  /**
   * Devolución POR RETIRO: el equipo no vuelve por un cambio ni por un daño,
   * vuelve porque el cliente se va. Además de soltar el equipo, deja al cliente
   * en RETIRADO e intenta el corte en el router (misma cascada que el cierre de
   * una orden de "Retiro voluntario", ver SupportWriteService.applyCloseCascade).
   */
  @IsOptional() @IsBoolean()
  withdrawal?: boolean;
}
