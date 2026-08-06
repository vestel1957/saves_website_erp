import { PortalService } from './portal.service';
import { PortalLoginDto } from './dto/portal.dto';

/**
 * Portal de autoservicio del ABONADO (migra `crm/user` + `crm/Payments`).
 * `/login` es público; el resto exige token de abonado (SubscriberAuthGuard).
 * NO usa el guard/áreas de staff: es un espacio de cliente aparte.
 */
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  /**
   * El login del abonado es número de abonado (secuencial) + documento: enumerar
   * abonados y probar cédulas es directo, así que necesita el mismo freno que el
   * login de staff, que sí lo tenía.
   */
  login(dto: PortalLoginDto) {
    return this.portal.login(dto.abonado, dto.document);
  }

  me(id: string) {
    return this.portal.me(id);
  }
}
