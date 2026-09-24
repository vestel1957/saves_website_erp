import { BadRequestException, NotFoundException } from '../core/http/errores';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MIMES_DOCUMENTO, enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco } from '../common/uploads';
import { StaffDocumentsService, type ArchivoSubido } from './staff-documents.service';
import { StaffService, CreateStaffDto, UpdateStaffDto, SetStaffPermissionsDto, SetStaffRolesDto, CreateStaffAccountDto, SetStaffAccountActiveDto, SetStaffBannedDto, ResetStaffPasswordDto } from './staff.service';
import { PerformanceService } from '../reports/performance.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';

export const DOCS_ROOT = join(process.cwd(), 'uploads', 'staff');
/** 20 MB: una hoja de vida escaneada cabe de sobra y frena las subidas absurdas. */
export const MAX_DOC_BYTES = 20 * 1024 * 1024;

/** Empleados / RRHH (migrado de saves-vestel). */
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly docs: StaffDocumentsService,
    private readonly performance: PerformanceService,
  ) {}

  stats() { return this.staff.stats(); }
  areas() { return this.staff.areas(); }
  /** Catálogo de roles disponibles para el selector de la ficha. */
  roleCatalog() { return this.staff.roleCatalog(); }
  /**
   * Lista de empleados: solo los activos.
   *
   * `inhabilitados=1` da vuelta a la lista y muestra únicamente a los que están
   * inhabilitados, y solo se lo permite al superusuario — es la única forma de
   * llegar a un ex-empleado para volver a habilitarlo. A cualquier otro se le
   * ignora el parámetro en vez de responderle un error: el filtro no existe en
   * su pantalla, así que solo llegaría escribiéndolo a mano.
   */
  list(actor: AuthUser, search?: string, role?: string, areaId?: string, inhabilitados?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    const esSuper = (actor?.permissions ?? []).includes(APP_PERMISSIONS.SYSTEM_ADMIN);
    return this.staff.list({ search, role, areaId, verInhabilitados: inhabilitados === '1' && esSuper, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  detail(id: string) { return this.staff.detail(id); }

  /** Funcionarios que afilian y cuántos clientes trajeron (/afiliados). */
  afiliados(from?: string, to?: string) { return this.staff.afiliadosResumen(from, to); }

  /** Clientes que trajo un funcionario, con fecha y hora del alta. */
  afiliadosDe(id: string, from?: string, to?: string) { return this.staff.afiliadosDe(id, from, to); }

  create(dto: CreateStaffDto) { return this.staff.create(dto); }
  update(id: string, dto: UpdateStaffDto, actor: AuthUser) { return this.staff.update(id, dto, actor); }

  /** Permisos del empleado (vista): cualquiera con acceso al área los consulta. */
  permissions(id: string) { return this.staff.permissions(id); }

  /** Editar los permisos del empleado: EXCLUSIVO del superusuario (system.admin). */
  setPermissions(id: string, dto: SetStaffPermissionsDto, actor: AuthUser) {
    return this.staff.setPermissions(id, dto.granted, actor);
  }

  /** Cambiar los roles del empleado: EXCLUSIVO del superusuario (system.admin). */
  setRoles(id: string, dto: SetStaffRolesDto, actor: AuthUser) {
    return this.staff.setRoles(id, dto.roleKeys, actor);
  }

  /** Crear la cuenta de acceso del empleado: EXCLUSIVO del superusuario. */
  createAccount(id: string, dto: CreateStaffAccountDto, actor: AuthUser) {
    return this.staff.createAccount(id, dto, actor);
  }

  /** Habilitar/inhabilitar el acceso: EXCLUSIVO del superusuario. */
  setAccountActive(id: string, dto: SetStaffAccountActiveDto, actor: AuthUser) {
    return this.staff.setAccountActive(id, dto.isActive, actor);
  }

  /** Inhabilitar/habilitar al funcionario entero: EXCLUSIVO del superusuario. */
  setBanned(id: string, dto: SetStaffBannedDto, actor: AuthUser) {
    return this.staff.setBanned(id, dto.banned, actor);
  }

  /** ¿Restablecerle la contraseña pide código, y a qué WhatsApp saldría? */
  passwordPolicy(id: string) {
    return this.staff.accountPasswordPolicy(id);
  }

  /** Manda al WhatsApp DEL EMPLEADO el código para restablecerle la contraseña. */
  requestPasswordCode(id: string, actor: AuthUser) {
    return this.staff.requestAccountPasswordCode(id, actor);
  }

  /** Restablecer la contraseña del empleado: EXCLUSIVO del superusuario. */
  resetPassword(id: string, dto: ResetStaffPasswordDto, actor: AuthUser) {
    return this.staff.resetAccountPassword(id, dto, actor);
  }

  /** Bitácora de cambios de acceso del empleado (consulta por el área). */
  audit(id: string) { return this.staff.accessAudit(id); }

  /**
   * Rendimiento del funcionario: las mismas métricas del tablero de /reportes,
   * acotadas a una persona y con la mediana del equipo al lado para poder leerlas.
   *
   * Vive aquí y no en `ReportsController` por los permisos: aquel exige el área
   * `gerencia` entera, que Administración no tiene — puede abrir la ficha pero no
   * pedir el reporte, y el bloque le daría 403.
   *
   * Se queda con la puerta de la clase (`administracion`/`gerencia`), la misma de
   * `detail` y `audit`, en vez de sumarle `HR_EMPLOYEES_READ` como los documentos:
   * aquí no hay cédulas ni contratos, son las órdenes de esa persona. Exigirlo
   * además dejaba fuera justo a Gerencia, que ya ve el desempeño de TODOS en
   * /reportes — el permiso habría escondido en la ficha lo que la otra pantalla
   * le muestra completo.
   *
   * Sin `from`/`to` el servicio toma los últimos 90 días.
   */
  rendimiento(id: string, from?: string, to?: string) {
    return this.performance.tecnico(id, from, to);
  }

  // ── Documentos del funcionario ───────────────────────────────────────────
  // Hoja de vida, cédula, contrato y certificados. Leer requiere el permiso de
  // RRHH de lectura y subir/borrar el de escritura: el área sola no basta, aquí
  // hay cédulas y contratos.

  listDocuments(id: string) {
    return this.docs.listar(id);
  }

  async uploadDocument(
    id: string,
    file: ArchivoSubido,
    kind: string | undefined,
    description: string | undefined,
    user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('No se recibió ningún archivo');
    try {
      const tipo = StaffDocumentsService.tipoValido(kind);
      return await this.docs.agregar(id, file, { kind: tipo, description }, user);
    } catch (e) {
      // El binario ya está en disco; si la fila no se pudo crear (empleado
      // inexistente, tipo inválido), no puede quedar huérfano ocupando espacio.
      try { unlinkSync(file.path); } catch { /* noop */ }
      throw e;
    }
  }

  async downloadDocument(id: string, docId: string, res: Response) {
    const doc = await this.docs.meta(id, docId);
    const abs = join(DOCS_ROOT, id, doc.storedName);
    if (!existsSync(abs)) throw new NotFoundException('El archivo ya no está en el servidor');
    return enviarAdjuntoSeguro(res, abs, doc.fileName);
  }

  async deleteDocument(id: string, docId: string) {
    const storedName = await this.docs.eliminar(id, docId);
    try { unlinkSync(join(DOCS_ROOT, id, storedName)); } catch { /* ya no existía */ }
    return { ok: true };
  }
}
