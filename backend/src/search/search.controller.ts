import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SearchService } from './search.service';

/**
 * Búsqueda con IA del ⌘K. Cualquier funcionario autenticado puede llamarla; el
 * servicio filtra internamente qué módulos consulta según su área (RBAC), así
 * que no lleva @RequireArea a nivel de ruta: la puerta está en los datos.
 */
@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post('ai')
  ai(@Body('q') q: string, @CurrentUser() user: AuthUser) {
    return this.search.search(q ?? '', user);
  }
}
