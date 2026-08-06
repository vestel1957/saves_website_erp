import {
  IsOptional, IsString, MaxLength, MinLength, IsDateString, ValidateIf, IsEmail, IsIn, IsObject, IsInt,
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

  @IsOptional() @IsIn(INSTALL_TECHS as unknown as string[])
  installTech?: string;
}

/**
 * Crear un cliente nuevo. Mismos campos que el update, pero con los mínimos
 * obligatorios del legacy (1er nombre, celular, correo, nacimiento). El
 * `abonado` se autogenera (max+1) si no viene.
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
