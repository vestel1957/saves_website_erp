import { DashboardService } from './dashboard.service';

/** Dashboard ejecutivo (agrega todos los verticales Vestel). */
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  summary() { return this.dashboard.summary(); }
}
