import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { ManualsService } from './manuals.service';

/**
 * Manuales de uso del sistema.
 *
 * NO lleva `PermissionsGuard`: el filtro no es "qué permiso hace falta para leer un
 * manual" sino "de quién es este manual", y eso lo resuelve el servicio cruzando el
 * catálogo con los roles de la sesión. Cada quien ve el suyo; el superusuario, todos.
 */
@Controller('manuals')
@UseGuards(JwtAuthGuard)
export class ManualsController {
  constructor(private readonly manuals: ManualsService) {}

  /** Manuales disponibles, con el del rol de quien pregunta marcado como suyo. */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.manuals.list(user);
  }

  /**
   * Sirve el PDF para verlo EN el navegador (`inline`), no como descarga: la gracia
   * es abrirlo y leerlo en el momento, no acumular archivos sueltos.
   */
  @Get(':slug/pdf')
  pdf(@Param('slug') slug: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const { path, nombre } = this.manuals.filePath(slug, user);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(nombre)}"`);
    return res.sendFile(path);
  }
}
