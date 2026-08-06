import { ForbiddenException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { APP_PERMISSIONS as P } from '../auth/permissions.catalog';
import type { AuthUser } from '../auth/current-user.decorator';

/**
 * Carpeta de los manuales. Se generan con `python3 documentacion/build_manuales.py`
 * a partir de los .md de `documentacion/fuentes/`, así que el PDF SIEMPRE se
 * regenera desde texto: nadie edita un PDF a mano.
 */
const DIR = resolve(process.cwd(), '..', 'documentacion', 'manuales');

/**
 * Catálogo de manuales.
 *
 * Es una lista FIJA en código, no un listado del directorio, por dos razones: el
 * `slug` que llega por la URL nunca se convierte en una ruta de archivo (no hay forma
 * de pedir `../../.env`), y cada manual necesita saber a qué rol le toca, que es un
 * dato que el nombre del archivo no tiene.
 *
 * `permisos` y `roles` = de quién es cada manual. SÍ es un gate: cada empleado ve
 * únicamente el suyo, y solo el superusuario los ve todos. Se aplica en las dos
 * puertas —el listado y la descarga del PDF—, porque filtrar solo el listado deja
 * el documento a un slug de distancia para quien conozca la URL.
 */
type ManualDef = {
  slug: string;
  titulo: string;
  bajada: string;
  archivo: string;
  /** Permisos que hacen que este manual sea "el tuyo". */
  permisos?: string[];
  /** Nombres de rol del ERP que hacen que este manual sea "el tuyo". */
  roles?: string[];
  /** Documento de referencia: no es de nadie en particular. */
  referencia?: boolean;
};

const MANUALES: ManualDef[] = [
  {
    slug: 'superadministrador',
    titulo: 'Superadministrador',
    bajada: 'Usuarios, roles, acceso y seguridad',
    archivo: 'Manual SAVES Vestel - del Superadministrador.pdf',
    permisos: [P.SYSTEM_ADMIN],
    roles: ['Superadministrador'],
  },
  {
    slug: 'gerencia',
    titulo: 'Gerencia',
    bajada: 'Panel ejecutivo, reportes y aprobación de compras',
    archivo: 'Manual SAVES Vestel - de Gerencia.pdf',
    permisos: [P.AREA_GERENCIA],
    roles: ['Gerencia'],
  },
  {
    slug: 'administracion',
    titulo: 'Administración',
    bajada: 'Clientes, inventario, compras y personal',
    archivo: 'Manual SAVES Vestel - de Administracion.pdf',
    permisos: [P.AREA_ADMINISTRACION],
    roles: ['Administración'],
  },
  {
    slug: 'contabilidad',
    titulo: 'Contabilidad y facturación',
    bajada: 'Facturación, notas, factura electrónica y contabilidad',
    archivo: 'Manual SAVES Vestel - de Contabilidad y Facturacion.pdf',
    permisos: [P.AREA_CONTABILIDAD],
    roles: ['Contabilidad'],
  },
  {
    slug: 'caja',
    titulo: 'Caja y ventas',
    bajada: 'Caja diaria, cobros y ventas',
    archivo: 'Manual SAVES Vestel - de Caja y Ventas.pdf',
    permisos: [P.AREA_CAJA],
    roles: ['Caja y ventas'],
  },
  {
    slug: 'tecnicos',
    titulo: 'Técnicos',
    bajada: 'Soporte técnico y operación de red',
    archivo: 'Manual SAVES Vestel - de Tecnicos.pdf',
    permisos: [P.AREA_TECNICOS],
    roles: ['Técnicos'],
  },
  {
    slug: 'sistemas',
    titulo: 'Sistemas',
    bajada: 'Configuración, WhatsApp y automatizaciones',
    archivo: 'Manual SAVES Vestel - de Sistemas.pdf',
    permisos: [P.AREA_SISTEMAS],
    roles: ['Sistemas'],
  },
  {
    slug: 'contador',
    titulo: 'Contador',
    bajada: 'Libros, estados financieros y mapeo de cuentas',
    archivo: 'Manual SAVES Vestel - del Contador.pdf',
    roles: ['Contador'],
  },
  {
    slug: 'jefe-bodega',
    titulo: 'Jefe de bodega',
    bajada: 'Material, equipos y despacho de inventario',
    archivo: 'Manual SAVES Vestel - del Jefe de Bodega.pdf',
    roles: ['Jefe de bodega'],
  },
  {
    slug: 'rrhh',
    titulo: 'Recursos humanos',
    bajada: 'Empleados, cuadrillas y accesos al sistema',
    archivo: 'Manual SAVES Vestel - de Recursos Humanos.pdf',
    permisos: [P.HR_EMPLOYEES_READ],
    roles: ['Director de Recursos Humanos'],
  },
  {
    slug: 'auditoria',
    titulo: 'Auditoría y consulta',
    bajada: 'Revisión de cifras y rastros de auditoría (solo lectura)',
    archivo: 'Manual SAVES Vestel - de Auditoria y Consulta.pdf',
    roles: ['Auditoría / Consulta'],
  },
  // La ficha del "Técnico de mantenimiento" se retiró el 2026-07-29 junto con su
  // rol: documentaba un módulo que no existe.
  {
    slug: 'matriz-roles',
    titulo: 'Matriz de roles y permisos',
    bajada: 'Qué ve y qué puede hacer cada rol, pantalla por pantalla',
    archivo: 'SAVES Vestel - Matriz de Roles y Permisos.pdf',
    referencia: true,
  },
];

/**
 * Manuales de uso del sistema, uno por rol.
 *
 * Cada quien ve el manual de SU rol y nada más; el superusuario los ve todos. Un
 * empleado que abre esta pantalla no tiene que elegir entre once documentos para
 * dar con el que le sirve.
 */
export class ManualsService {
  private readonly logger = new Logger('Manuales');

  /** ¿Este manual es el del rol de quien pregunta? */
  private esMio(m: ManualDef, permisos: Set<string>, roles: Set<string>) {
    if (m.referencia) return false;
    return (m.permisos ?? []).some((p) => permisos.has(p))
      || (m.roles ?? []).some((r) => roles.has(r.toLowerCase()));
  }

  /**
   * Manuales que este usuario tiene permitido ver.
   *
   * El superusuario se resuelve aparte y no por el bypass de permisos: como cumple
   * TODOS los permisos, `esMio` le daría cierto en los once y el destaque dejaría de
   * significar nada. Se le devuelve el catálogo completo con el suyo marcado.
   */
  private visibles(user: AuthUser) {
    const permisos = new Set(user?.permissions ?? []);
    const roles = new Set((user?.roles ?? []).map((r) => r.toLowerCase()));
    const esAdmin = permisos.has(P.SYSTEM_ADMIN);

    if (esAdmin) {
      return MANUALES.map((m) => ({ def: m, mio: m.slug === 'superadministrador' }));
    }
    return MANUALES
      .filter((m) => this.esMio(m, permisos, roles))
      .map((m) => ({ def: m, mio: true }));
  }

  /**
   * Lista los manuales que le corresponden a quien pregunta.
   *
   * Se comprueba que el PDF exista de verdad: si alguien mueve la carpeta o el
   * generador falla, es mejor que el manual aparezca como "no disponible" a que el
   * usuario haga clic y reciba un error.
   */
  list(user: AuthUser) {
    return this.visibles(user).map(({ def: m, mio }) => {
      const ruta = join(DIR, m.archivo);
      const existe = existsSync(ruta);
      return {
        slug: m.slug,
        titulo: m.titulo,
        bajada: m.bajada,
        referencia: !!m.referencia,
        mio,
        disponible: existe,
        peso: existe ? Math.round(statSync(ruta).size / 1024) : null,
        actualizado: existe ? statSync(ruta).mtime : null,
      };
    });
  }

  /**
   * Ruta en disco de un manual, comprobando que sea de quien lo pide.
   *
   * El slug se resuelve contra el catálogo, nunca se concatena a la ruta. Y se
   * vuelve a verificar el permiso aquí: esconder un documento del listado no lo
   * protege de quien escriba la URL a mano.
   */
  filePath(slug: string, user: AuthUser): { path: string; nombre: string } {
    const m = MANUALES.find((x) => x.slug === slug);
    if (!m) throw new NotFoundException('Ese manual no existe.');

    if (!this.visibles(user).some(({ def }) => def.slug === slug)) {
      throw new ForbiddenException('Ese manual es de otro rol. Solo puedes abrir el tuyo.');
    }

    const path = join(DIR, m.archivo);
    if (!existsSync(path)) {
      this.logger.warn(`Falta el PDF del manual "${slug}" en ${DIR}. ¿Se corrió build_manuales.py?`);
      throw new NotFoundException('El manual todavía no está generado.');
    }
    return { path, nombre: m.archivo };
  }
}
