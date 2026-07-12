import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PortalService } from './portal.service';
import { SubscriberAuthGuard, CurrentSubscriber } from './subscriber-auth.guard';
import { PortalLoginDto } from './dto/portal.dto';

/**
 * Portal de autoservicio del ABONADO (migra `crm/user` + `crm/Payments`).
 * `/login` es público; el resto exige token de abonado (SubscriberAuthGuard).
 * NO usa el guard/áreas de staff: es un espacio de cliente aparte.
 */
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Post('login')
  login(@Body() dto: PortalLoginDto) {
    return this.portal.login(dto.abonado, dto.document);
  }

  @UseGuards(SubscriberAuthGuard)
  @Get('me')
  me(@CurrentSubscriber() id: string) {
    return this.portal.me(id);
  }
}
