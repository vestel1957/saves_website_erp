import { OnlinePaymentsService } from './online-payments.service';
import { AuthUser } from '../auth/current-user.decorator';
import { ClavePortalDto, RunPuenteDto } from './dto/online-payments.dto';

/**
 * Pagos en línea del portal del abonado (`vestel.com.co/crm`).
 *
 * Solo lectura + un disparo manual de la pasada. Aquí no se aplica plata: el pago lo
 * procesa el portal contra el legacy y llega por el sync (ver `OnlinePaymentsService`).
 *
 * Área `contabilidad` para consultar —es dinero recaudado, del mismo rango que
 * Movimientos— y `administracion` para forzar la pasada, que sale a tocar routers y
 * OLTs y no es un botón de consulta.
 */
export class OnlinePaymentsController {
  constructor(private readonly pagos: OnlinePaymentsService) {}

  list(query: { estado?: string; search?: string; from?: string; to?: string; page?: string; pageSize?: string }) {
    return this.pagos.list({
      estado: query.estado, search: query.search, from: query.from, to: query.to,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }

  summary(query: { from?: string; to?: string }) {
    return this.pagos.summary({ from: query.from, to: query.to });
  }

  detail(id: string) {
    return this.pagos.detail(id);
  }

  /**
   * Fuerza una pasada del puente sin esperar al cron.
   *
   * `dias` abre la ventana de reconexión hacia atrás y `dryRun` la deja en simulación
   * (dice a quién reconectaría sin tocar un solo equipo).
   */
  async run(dto: RunPuenteDto, _user: AuthUser) {
    const ingesta = await this.pagos.ingest();
    const reconexion = await this.pagos.reconectar({
      dias: dto?.dias,
      dryRun: dto?.dryRun === true,
    });
    return { ok: true, ingesta, reconexion };
  }

  /**
   * Con qué usuario entra el abonado al portal y cuándo se le cambió la clave por
   * última vez. La clave nunca se devuelve: no está guardada en ninguna parte.
   */
  credencial(subscriberId: string, user: AuthUser) {
    return this.pagos.credencialPortal(subscriberId, user);
  }

  /**
   * Le fija al abonado una contraseña nueva para pagar en línea.
   *
   * Va con las áreas de la ficha del cliente —caja incluida— porque es trabajo de
   * ventanilla: el cliente que no puede entrar a pagar lo dice ahí. El alcance por
   * sede lo aplica el servicio, así que una cajera no llega a un cliente de otra sede.
   */
  cambiarClave(subscriberId: string, dto: ClavePortalDto, user: AuthUser) {
    return this.pagos.cambiarClavePortal(subscriberId, dto.password, user);
  }
}
