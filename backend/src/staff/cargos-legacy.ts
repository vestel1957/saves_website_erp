import { Prisma } from '@prisma/client';

/**
 * Los cargos del legacy: `Staff.role` = `aauth_users.roleid`.
 *
 * ESTE ARCHIVO ES LA ÚNICA FUENTE. Antes el mapa estaba copiado en cuatro sitios
 * (StaffService, el catálogo de la búsqueda IA, el toolset de RRHH del chatbot y
 * las dos pantallas de empleados) y las copias se desincronizaron: los códigos 2 y
 * 3 estaban cambiados, así que el sistema entero llamaba "Cajero" a los técnicos y
 * "Técnico" a las cajeras. Quien preguntaba al chatbot por "la lista de los
 * técnicos" recibía las cajeras. Si mañana hace falta un cargo nuevo, se agrega
 * aquí y sale en todas partes.
 *
 * Que 2 sea el técnico y 3 el cajero no es una elección de diseño, es lo que dice
 * el dato (verificado 2026-07-30):
 *
 *   - Rol 2: 12 activos, todos del área Operativa, miles de órdenes de campo y
 *     CERO movimientos de caja. 11 de sus usuarios se llaman `*tecnico*`, ninguno
 *     `*cajer*`.
 *   - Rol 3: 4 activos, todos del área Comercial, con la caja gruesa (Sonia
 *     Barreto: 124.811 transacciones). 3 de sus usuarios se llaman `*cajer*`.
 *
 * Los comentarios de `permissions.catalog.ts` que hablan de "cajera, roleid=3" ya
 * decían lo correcto: el que estaba mal era el mapa de etiquetas.
 *
 * NO confundir con los roles RBAC (`Role`/`roleCatalog`), que son otra cosa: estos
 * son el cargo heredado del legacy y no otorgan ningún permiso.
 */
export const CARGO_TECNICO = 2;
export const CARGO_CAJERO = 3;
export const CARGO_ADMINISTRATIVO = 4;
export const CARGO_ADMINISTRADOR = 5;

export const CARGO_LEGACY: Record<number, string> = {
  [CARGO_TECNICO]: 'Técnico',
  [CARGO_CAJERO]: 'Cajero',
  [CARGO_ADMINISTRATIVO]: 'Administrativo',
  [CARGO_ADMINISTRADOR]: 'Administrador',
};

/** Etiqueta que se usa cuando el código no está en el mapa. */
export const CARGO_OTRO = 'Otro';

/** Pares [código, etiqueta] para armar selectores y enumeraciones. */
export const CARGOS_LEGACY: [number, string][] = Object.entries(CARGO_LEGACY).map(
  ([codigo, etiqueta]) => [Number(codigo), etiqueta],
);

/** Solo las etiquetas, en el orden del catálogo. */
export const ETIQUETAS_CARGO = CARGOS_LEGACY.map(([, etiqueta]) => etiqueta);

/** `Staff.role` → nombre del cargo. `null` si no tiene o no se reconoce. */
export const cargoLegacy = (role?: number | null): string | null =>
  role == null ? null : (CARGO_LEGACY[role] ?? null);

/**
 * El mismo mapa como `CASE` de SQL, para el catálogo de la búsqueda IA, que
 * agrupa y filtra del lado de Postgres. Se genera del mapa en vez de escribirse a
 * mano: era una de las cuatro copias que se desincronizaron.
 *
 * `columna` llega desde el catálogo (p. ej. `e.role`) y NUNCA desde el usuario.
 */
export const cargoSqlCase = (columna: string): Prisma.Sql =>
  Prisma.raw(
    `CASE ${columna} ` +
      CARGOS_LEGACY.map(([codigo, etiqueta]) => `WHEN ${codigo} THEN '${etiqueta}'`).join(' ') +
      ` ELSE '${CARGO_OTRO}' END`,
  );

/**
 * Nombre de cargo → código. Tolerante con lo que escriba una persona o el modelo:
 * sin tildes, en singular o plural ("tecnicos", "cajeras"), en cualquier caja.
 */
export function codigoDeCargo(nombre: string): number | null {
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const q = norm(nombre).replace(/(es|s|as|os)$/, '');
  if (!q) return null;
  const hit = CARGOS_LEGACY.find(
    ([, etiqueta]) => norm(etiqueta).startsWith(q) || q.startsWith(norm(etiqueta)),
  );
  return hit ? hit[0] : null;
}
