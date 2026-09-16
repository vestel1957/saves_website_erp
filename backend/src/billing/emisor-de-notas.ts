import { ForbiddenException } from '../core/http/errores';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import type { AuthUser } from '../auth/current-user.decorator';

/**
 * Quién puede EMITIR una nota crédito/débito (2026-09-10).
 *
 * Una nota crédito le rebaja al abonado lo que debe sin que entre un peso, y una
 * nota débito se lo sube: es la única escritura de facturación que mueve cartera
 * sin caja de por medio y sin dejar factura nueva. Hasta hoy la firmaba cualquiera
 * del área de contabilidad, y por el atajo del superusuario también los trece
 * `system.admin`. Por decisión de negocio pasa a ser NOMINAL: la emiten las
 * personas a las que se les concede el permiso, una por una.
 *
 * SIN ATAJO DE SUPERUSUARIO — y no es un olvido. `exigirPermisos()` deja pasar a
 * `system.admin` antes de mirar nada, así que montado como middleware normal esto
 * no restringiría a nadie: los dos autorizados SON superusuarios, igual que los
 * otros once. Por eso se comprueba aquí, contra la lista de permisos efectivos tal
 * cual viene de la sesión, y por eso el permiso está fuera del rol `super-admin`
 * (ver `PERMISOS_NOMINALES` en el catálogo).
 *
 * Vive en el SERVICIO y no en la ruta a propósito: las notas entran por tres
 * puertas —la nota suelta, el lote de depuración de cartera y la nota crédito
 * electrónica ante la DIAN—, y una comprobación por ruta se olvida en la cuarta.
 *
 * NO cubre `aplicarNotaEnTx`, que es la primitiva: por ahí pasan las notas que
 * genera el SISTEMA solo (descuento de pronto pago del portal, reversa de un
 * descuento vencido, aplicación de un anticipo). Ésas no las emite una persona y
 * frenarlas dejaría cartera a medio cuadrar.
 */
export function puedeEmitirNotas(user: Pick<AuthUser, 'permissions'> | null | undefined): boolean {
  return !!user?.permissions?.includes(APP_PERMISSIONS.BILLING_NOTES_EMIT);
}

/** Igual que la anterior, pero cortando la petición con un 403 que se entienda. */
export function exigirEmisorDeNotas(user: Pick<AuthUser, 'permissions'> | null | undefined): void {
  if (puedeEmitirNotas(user)) return;
  throw new ForbiddenException(
    'No estás autorizado para emitir notas crédito o débito. Esta operación está reservada a las personas con el permiso "Emitir notas crédito/débito".',
  );
}
