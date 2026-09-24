/**
 * CAMBIO DE TITULAR: a nombre de quién queda el servicio.
 *
 * Hasta 2026-09-17 no había trámite: el legacy lo hacía en mostrador corrigiendo la
 * ficha a mano, y aquí igual (el lápiz de la tarjeta Contacto). No quedaba registro
 * de quién era el titular antes ni de cuándo cambió. Ahora es una ORDEN
 * ('Cambio de titular', decisión del usuario) que pide los datos del nuevo titular,
 * los escribe en la ficha al abrirse —como el traslado escribe la dirección— y
 * guarda la foto del titular anterior.
 *
 * Solo cambia la PERSONA (nombre, documento, contacto). La cuenta es la misma: el
 * número de abonado, los servicios, el equipo y la deuda siguen donde estaban.
 */

import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { BadRequestException } from '../core/http/errores';

/** Los mismos de la ficha (`update-subscriber.dto.ts`). */
export const TIPOS_CLIENTE_TITULAR = ['Natural', 'Juridico', 'Gubernamental', 'Militar'] as const;

/**
 * Los datos del nuevo titular. Son las columnas de la ficha que dicen QUIÉN es el
 * cliente, con los mismos topes que la edición de la ficha.
 */
export class NuevoTitularDto {
  @IsOptional() @IsIn(TIPOS_CLIENTE_TITULAR as unknown as string[]) customerType?: string;
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) secondName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName1?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName2?: string;
  /** Razón social: la usa el titular que no es persona natural. */
  @IsOptional() @IsString() @MaxLength(200) companyName?: string;
  @IsString() @MinLength(1) @MaxLength(20) docType!: string;
  @IsString() @MinLength(3) @MaxLength(40) docNumber!: string;
  @IsString() @MinLength(7) @MaxLength(40) phone1!: string;
  @IsOptional() @IsString() @MaxLength(40) phone2?: string;
  @IsOptional() @ValidateIf((o) => o.email !== '' && o.email != null) @IsEmail() email?: string;
}

/** La ficha, en lo que dice quién es el titular. */
export type FichaParaTitular = {
  customerType: string | null;
  firstName: string | null;
  secondName: string | null;
  lastName1: string | null;
  lastName2: string | null;
  companyName: string | null;
  fullName: string | null;
  docType: string | null;
  docNumber: string | null;
  phone1: string | null;
  phone2: string | null;
  email: string | null;
};

export const SELECT_TITULAR = {
  customerType: true, firstName: true, secondName: true, lastName1: true, lastName2: true,
  companyName: true, fullName: true, docType: true, docNumber: true,
  phone1: true, phone2: true, email: true,
} as const;

export type CambioTitularArmado = {
  /** Los datos nuevos tal cual se guardan en la orden (`Ticket.holderTo`). */
  nuevo: Record<string, string | null>;
  /** Foto del titular que tenía la ficha al abrir la orden (`Ticket.holderFrom`). */
  anterior: Record<string, string | null>;
  textoNuevo: string;
  textoAnterior: string | null;
  /** El nuevo es la misma persona (mismo documento): la ficha se corrige igual. */
  mismoDocumento: boolean;
  /** El parche de la ficha: reemplaza TODOS los datos de la persona. */
  fichaData: Record<string, string | null>;
  notaObservacion: string;
};

const limpio = (v?: string | null) => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
};

/** 'Juan Pérez · CC 123' — lo que se lee en la orden y viaja en la observación. */
export function textoTitular(d: Partial<Record<string, string | null>>): string | null {
  const nombre = limpio(d.fullName)
    ?? limpio([d.firstName, d.secondName, d.lastName1, d.lastName2].map((x) => limpio(x)).filter(Boolean).join(' '))
    ?? limpio(d.companyName);
  const doc = limpio([limpio(d.docType), limpio(d.docNumber)].filter(Boolean).join(' '));
  if (!nombre && !doc) return null;
  return [nombre ?? 'sin nombre', doc].filter(Boolean).join(' · ');
}

/**
 * Valida los datos del nuevo titular y arma lo que se guarda en la orden y en la
 * ficha. Lanza 400 si falta lo que hace falta para saber quién es.
 */
export function armarCambioTitular(dto: NuevoTitularDto, sub: FichaParaTitular): CambioTitularArmado {
  const customerType = limpio(dto.customerType) ?? 'Natural';
  const natural = customerType === 'Natural';
  const nuevo: Record<string, string | null> = {
    customerType,
    firstName: limpio(dto.firstName),
    secondName: limpio(dto.secondName),
    lastName1: limpio(dto.lastName1),
    lastName2: limpio(dto.lastName2),
    companyName: limpio(dto.companyName),
    docType: limpio(dto.docType)?.toUpperCase() ?? null,
    docNumber: limpio(dto.docNumber)?.replace(/[\s.]/g, '') ?? null,
    phone1: limpio(dto.phone1),
    phone2: limpio(dto.phone2),
    email: limpio(dto.email)?.toLowerCase() ?? null,
  };
  if (natural && (!nuevo.firstName || !nuevo.lastName1)) {
    throw new BadRequestException('Escribe el nombre y el primer apellido del nuevo titular.');
  }
  if (!natural && !nuevo.companyName) {
    throw new BadRequestException('Escribe la razón social del nuevo titular.');
  }
  if (!nuevo.docType || !nuevo.docNumber) {
    throw new BadRequestException('Escribe el tipo y el número de documento del nuevo titular.');
  }
  if (!nuevo.phone1) {
    throw new BadRequestException('Escribe un celular del nuevo titular.');
  }

  const personaNombre = [nuevo.firstName, nuevo.secondName, nuevo.lastName1, nuevo.lastName2].filter(Boolean).join(' ');
  // El mismo criterio que el alta: la persona manda y, sin ella, la razón social.
  const fullName = personaNombre || nuevo.companyName;
  const fichaData = { ...nuevo, fullName };

  const anterior: Record<string, string | null> = {
    customerType: sub.customerType, firstName: sub.firstName, secondName: sub.secondName,
    lastName1: sub.lastName1, lastName2: sub.lastName2, companyName: sub.companyName,
    fullName: sub.fullName, docType: sub.docType, docNumber: sub.docNumber,
    phone1: sub.phone1, phone2: sub.phone2, email: sub.email,
  };
  const textoNuevo = textoTitular(fichaData)!;
  const textoAnterior = textoTitular(anterior);
  const docAnterior = (sub.docNumber ?? '').replace(/[\s.]/g, '');
  const mismoDocumento = !!docAnterior && docAnterior === nuevo.docNumber;

  return {
    nuevo,
    anterior,
    textoNuevo,
    textoAnterior,
    mismoDocumento,
    fichaData,
    notaObservacion: `Cambio de titular: de ${textoAnterior ?? 'titular sin registrar'} a ${textoNuevo}.`,
  };
}
