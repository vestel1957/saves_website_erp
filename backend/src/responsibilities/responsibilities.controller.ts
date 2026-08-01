import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ResponsibilitiesService } from './responsibilities.service';
import { SetHoldersDto } from './dto/responsibilities.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';

/**
 * Encargados por cargo: quién es el de call center, el de bodega, el de cartera.
 *
 * Restringido a sistemas y gerencia igual que el resto de Configuración. Nombrar al
 * encargado de un frente decide a quién le llega el trabajo, así que no es una
 * preferencia personal: es organización de la empresa.
 */
@Controller('responsibilities')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('sistemas', 'gerencia')
export class ResponsibilitiesController {
  constructor(private readonly responsibilities: ResponsibilitiesService) {}

  @Get() list() {
    return this.responsibilities.list();
  }

  /** Usuarios activos que se pueden nombrar (para el selector de la pantalla). */
  @Get('assignable') assignable() {
    return this.responsibilities.assignableUsers();
  }

  @Put(':post') set(@Param('post') post: string, @Body() body: SetHoldersDto, @CurrentUser() u?: AuthUser) {
    return this.responsibilities.setHolders(post, body?.holders ?? [], u?.name ?? u?.email);
  }
}
