// Constantes compartidas del módulo de Recursos Humanos (empleados + documentos).

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
