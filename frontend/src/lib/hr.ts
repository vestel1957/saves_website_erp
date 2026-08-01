// Constantes compartidas del módulo de Recursos Humanos (empleados + documentos).

/**
 * Cargos del legacy (`Staff.role` = `aauth_users.roleid`). Espejo de
 * `backend/src/staff/cargos-legacy.ts`, que es la fuente: las etiquetas que se ven
 * en una fila o en una ficha vienen del backend en `roleLabel`; este mapa es solo
 * para los selectores (filtro de la lista y el desplegable de edición), donde hace
 * falta el código numérico.
 *
 * Ojo con tocarlo: el 2 es el TÉCNICO y el 3 el CAJERO, aunque el número sugiera lo
 * contrario. Estuvieron cambiados y por eso el sistema entero llamaba "Cajero" a
 * Luis Fabián (usuario `Fabiantecnico`, 12.938 órdenes de campo, cero caja) y
 * "Técnico" a Sonia (usuario `SoniaCajera`, 124.811 movimientos de caja). Si vas a
 * cambiar el mapa, cámbialo primero en el backend.
 */
export const CARGOS_LEGACY: [string, string][] = [
  ["2", "Técnico"],
  ["3", "Cajero"],
  ["4", "Administrativo"],
  ["5", "Administrador"],
];

export const CARGO_LABEL: Record<string, string> = Object.fromEntries(CARGOS_LEGACY);

export const EMPLOYEE_STATUS: [string, string][] = [
  ["ACTIVE", "Activo"],
  ["ON_LEAVE", "Incapacidad / licencia"],
  ["INACTIVE", "Inactivo"],
  ["TERMINATED", "Retirado"],
];

export const STATUS_LABEL: Record<string, string> = Object.fromEntries(EMPLOYEE_STATUS);

export const STATUS_STYLE: Record<string, string> = {
  ACTIVE: "bg-emerald-500/15 text-emerald-600",
  ON_LEAVE: "bg-amber-500/15 text-amber-600",
  INACTIVE: "bg-surface-2 text-text-secondary",
  TERMINATED: "bg-rose-500/15 text-rose-600",
};

export const DOC_TYPES: [string, string][] = [
  ["CC", "Cédula de ciudadanía"],
  ["CE", "Cédula de extranjería"],
  ["TI", "Tarjeta de identidad"],
  ["PASAPORTE", "Pasaporte"],
  ["NIT", "NIT"],
  ["OTRO", "Otro"],
];

/** Modalidades de contrato laboral (Colombia). */
export const CONTRACT_TYPES = [
  "Término indefinido",
  "Término fijo",
  "Obra o labor",
  "Prestación de servicios",
  "Aprendizaje",
] as const;

export const DOC_KIND_LABEL: Record<string, string> = {
  CV: "Hoja de vida",
  IDENTITY: "Documento de identidad",
  CONTRACT: "Contrato laboral",
  CERTIFICATE: "Certificado / otro",
  OTHER: "Otro",
};

export const DOC_KIND_OPTIONS = ["CV", "IDENTITY", "CONTRACT", "CERTIFICATE", "OTHER"] as const;
