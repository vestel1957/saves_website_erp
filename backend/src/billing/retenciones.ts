/**
 * Retenciones de la factura de venta. Viven fuera del DTO a propósito: `nota-en-tx.ts`
 * las necesita y el DTO arrastra los decoradores de `class-validator`, que exigen
 * `reflect-metadata` cargado. Importarlo desde ahí obligaba a media base de código a
 * cargar el runtime de Nest sólo para escribir una nota crédito.
 *
 * ReteICA no existe en el legacy — no agregar sin decisión de negocio.
 */
export const RETENTION_TYPES = ['Retefuente Servicios', 'Compras', 'Personas no declarantes', 'Reteiva'] as const;
export type RetentionLabel = (typeof RETENTION_TYPES)[number];

/** Etiqueta del legacy → valor del enum Prisma `RetentionType`. */
export const RETENTION_LABEL_TO_ENUM: Record<RetentionLabel, 'RETEFUENTE_SERVICIOS' | 'COMPRAS' | 'PERSONAS_NO_DECLARANTES' | 'RETEIVA'> = {
  'Retefuente Servicios': 'RETEFUENTE_SERVICIOS',
  Compras: 'COMPRAS',
  'Personas no declarantes': 'PERSONAS_NO_DECLARANTES',
  Reteiva: 'RETEIVA',
};
