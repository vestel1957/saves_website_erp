import { AuthUser } from '../auth/current-user.decorator';
import { DashboardService } from './dashboard.service';

/** Dashboard ejecutivo (agrega todos los verticales Vestel). */
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * `from`/`to` en 'YYYY-MM-DD'. Sin rango: el mes en curso.
   * `sede` es el `Branch.legacyId` a mirar; sin ella, todas las que alcance el usuario.
   */
  summary(from?: string, to?: string, sede?: string, user?: AuthUser) {
    return this.dashboard.summary(from, to, sede, user);
  }

  /** Listado detrás de las cards "Abonados nuevos" / "Retiros" (`tipo` = nuevos | retiros). */
  movimientoAbonados(tipo?: string, from?: string, to?: string, sede?: string, user?: AuthUser) {
    return this.dashboard.movimientoAbonados(tipo, from, to, sede, user);
  }
}
