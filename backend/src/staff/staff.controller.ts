import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MIMES_DOCUMENTO, enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco } from '../common/uploads';
import { StaffDocumentsService, type ArchivoSubido } from './staff-documents.service';
import { StaffService, CreateStaffDto, UpdateStaffDto, SetStaffPermissionsDto, SetStaffRolesDto, CreateStaffAccountDto, SetStaffAccountActiveDto, SetStaffBannedDto, ResetStaffPasswordDto } from './staff.service';
import { PerformanceService } from '../reports/performance.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

const DOCS_ROOT = join(process.cwd(), 'uploads', 'staff');
/** 20 MB: una hoja de vida escaneada cabe de sobra y frena las subidas absurdas. */
const MAX_DOC_BYTES = 20 * 1024 * 1024;

/** Empleados / RRHH (migrado de saves-vestel). */
@Controller('staff')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'gerencia')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly docs: StaffDocumentsService,
    private readonly performance: PerformanceService,
  ) {}

  @Get('stats') stats() { return this.staff.stats(); }
  @Get('areas') areas() { return this.staff.areas(); }
  /** Catálogo de roles disponibles para el selector de la ficha. */
  @Get('role-catalog') roleCatalog() { return this.staff.roleCatalog(); }
  /**
   * Lista de empleados: solo los activos.
   *
   * `inhabilitados=1` da vuelta a la lista y muestra únicamente a los que están
   * inhabilitados, y solo se lo permite al superusuario — es la única forma de
   * llegar a un ex-empleado para volver a habilitarlo. A cualquier otro se le
   * ignora el parámetro en vez de responderle un error: el filtro no existe en
   * su pantalla, así que solo llegaría escribiéndolo a mano.
   */
  @Get()
  list(@CurrentUser() actor: AuthUser, @Query('search') search?: string, @Query('role') role?: string, @Query('areaId') areaId?: string, @Query('inhabilitados') inhabilitados?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string) {
    const esSuper = (actor?.permissions ?? []).includes(APP_PERMISSIONS.SYSTEM_ADMIN);
    return this.staff.list({ search, role, areaId, verInhabilitados: inhabilitados === '1' && esSuper, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  @Get(':id') detail(@Param('id') id: string) { return this.staff.detail(id); }
  @Post() create(@Body() dto: CreateStaffDto) { return this.staff.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateStaffDto, @CurrentUser() actor: AuthUser) { return this.staff.update(id, dto, actor); }

  /** Permisos del empleado (vista): cualquiera con acceso al área los consulta. */
  @Get(':id/permissions') permissions(@Param('id') id: string) { return this.staff.permissions(id); }

  /** Editar los permisos del empleado: EXCLUSIVO del superusuario (system.admin). */
  @Patch(':id/permissions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  setPermissions(@Param('id') id: string, @Body() dto: SetStaffPermissionsDto, @CurrentUser() actor: AuthUser) {
    return this.staff.setPermissions(id, dto.granted, actor);
  }

  /** Cambiar los roles del empleado: EXCLUSIVO del superusuario (system.admin). */
  @Patch(':id/roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  setRoles(@Param('id') id: string, @Body() dto: SetStaffRolesDto, @CurrentUser() actor: AuthUser) {
    return this.staff.setRoles(id, dto.roleKeys, actor);
  }

  /** Crear la cuenta de acceso del empleado: EXCLUSIVO del superusuario. */
  @Post(':id/account')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  createAccount(@Param('id') id: string, @Body() dto: CreateStaffAccountDto, @CurrentUser() actor: AuthUser) {
    return this.staff.createAccount(id, dto, actor);
  }

  /** Habilitar/inhabilitar el acceso: EXCLUSIVO del superusuario. */
  @Patch(':id/account/active')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  setAccountActive(@Param('id') id: string, @Body() dto: SetStaffAccountActiveDto, @CurrentUser() actor: AuthUser) {
    return this.staff.setAccountActive(id, dto.isActive, actor);
  }

  /** Inhabilitar/habilitar al funcionario entero: EXCLUSIVO del superusuario. */
  @Patch(':id/banned')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  setBanned(@Param('id') id: string, @Body() dto: SetStaffBannedDto, @CurrentUser() actor: AuthUser) {
    return this.staff.setBanned(id, dto.banned, actor);
  }

  /** ¿Restablecerle la contraseña pide código, y a qué WhatsApp saldría? */
  @Get(':id/account/password/policy')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  passwordPolicy(@Param('id') id: string) {
    return this.staff.accountPasswordPolicy(id);
  }

  /** Manda al WhatsApp DEL EMPLEADO el código para restablecerle la contraseña. */
  @Post(':id/account/password/code')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  requestPasswordCode(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.staff.requestAccountPasswordCode(id, actor);
  }

  /** Restablecer la contraseña del empleado: EXCLUSIVO del superusuario. */
  @Post(':id/account/password')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  resetPassword(@Param('id') id: string, @Body() dto: ResetStaffPasswordDto, @CurrentUser() actor: AuthUser) {
    return this.staff.resetAccountPassword(id, dto, actor);
  }

  /** Bitácora de cambios de acceso del empleado (consulta por el área). */
  @Get(':id/audit') audit(@Param('id') id: string) { return this.staff.accessAudit(id); }

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
  @Get(':id/rendimiento')
  rendimiento(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.performance.tecnico(id, from, to);
  }

  // ── Documentos del funcionario ───────────────────────────────────────────
  // Hoja de vida, cédula, contrato y certificados. Leer requiere el permiso de
  // RRHH de lectura y subir/borrar el de escritura: el área sola no basta, aquí
  // hay cédulas y contratos.

  @Get(':id/documents')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.HR_EMPLOYEES_READ)
  listDocuments(@Param('id') id: string) {
    return this.docs.listar(id);
  }

  @Post(':id/documents')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.HR_EMPLOYEES_WRITE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(DOCS_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        // La extensión sale del MIME ya validado por `fileFilter`, NUNCA del
        // `originalname`: por ahí es por donde entraba un .html disfrazado.
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: MAX_DOC_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = mimeAceptado(file.mimetype, MIMES_DOCUMENTO);
        cb(ok ? null : new BadRequestException('Solo se aceptan PDF, imágenes o Word'), ok);
      },
    }),
  )
  async uploadDocument(
    @Param('id') id: string,
    @UploadedFile() file: ArchivoSubido,
    @Body('kind') kind: string | undefined,
    @Body('description') description: string | undefined,
    @CurrentUser() user: AuthUser,
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

  @Get(':id/documents/:docId/download')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.HR_EMPLOYEES_READ)
  async downloadDocument(@Param('id') id: string, @Param('docId') docId: string, @Res() res: Response) {
    const doc = await this.docs.meta(id, docId);
    const abs = join(DOCS_ROOT, id, doc.storedName);
    if (!existsSync(abs)) throw new NotFoundException('El archivo ya no está en el servidor');
    return enviarAdjuntoSeguro(res, abs, doc.fileName);
  }

  @Delete(':id/documents/:docId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.HR_EMPLOYEES_WRITE)
  async deleteDocument(@Param('id') id: string, @Param('docId') docId: string) {
    const storedName = await this.docs.eliminar(id, docId);
    try { unlinkSync(join(DOCS_ROOT, id, storedName)); } catch { /* ya no existía */ }
    return { ok: true };
  }
}
