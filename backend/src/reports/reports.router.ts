/**
 * Rutas de reports — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ReportsController, que ya no lleva decoradores.
 *
 * Endpoints: 23
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, exigirArea } from '../core/auth/instancias';
import { ReportsController } from './reports.controller';
import { ispReportsService, metricsService, performanceService, reportsService, staffReportsService } from '../core/contenedor';
import { ReportsService } from './reports.service';
import { PerformanceService } from './performance.service';
import { StaffReportsService } from './staff-reports.service';
import { MetricsService, METRICAS, ETIQUETA, NO_RECONSTRUIBLES, NO_SUMABLES } from './metrics.service';
import { IspReportsService } from './isp-reports.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const reports = new ReportsController(reportsService, performanceService, staffReportsService, metricsService, ispReportsService);

export const reportsRouter = crearRouter();
reportsRouter.get(
  '/actividad',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.actividad(req.query.from as string, req.query.to as string, req.query.usuario as string, req.query.entidad as string, req.query.accion as string)),
);

reportsRouter.get(
  '/anulaciones',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.anulaciones(req.query.from as string, req.query.to as string, req.query.quien as string, req.query.sede as string)),
);

reportsRouter.get(
  '/arpu',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.arpu(req.query.from as string, req.query.to as string, req.query.sede as string)),
);

reportsRouter.get(
  '/capacidad-red',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.capacidadRed(req.query.sede as string)),
);

reportsRouter.get(
  '/cortes-activaciones',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.cortesActivaciones(req.query.from as string, req.query.to as string, req.query.sede as string)),
);

reportsRouter.get(
  '/estadisticas-servicios',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.estadisticasServicios()),
);

reportsRouter.get(
  '/indice-recaudo',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.indiceRecaudo(req.query.from as string, req.query.to as string, req.query.sede as string)),
);

reportsRouter.get(
  '/ingresos-egresos',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.ingresosEgresos()),
);

reportsRouter.get(
  '/iva',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.iva(req.query.tipo as string, req.query.from as string, req.query.to as string, req.query.sede as string)),
);

reportsRouter.get(
  '/movimientos',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.movimientos(req.query.from as string, req.query.to as string, req.query.sede as string)),
);

reportsRouter.get(
  '/ordenes',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.ordenes(req.query.from as string, req.query.to as string, req.query.sede as string)),
);

reportsRouter.get(
  '/permanencia',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.permanencia(req.query.sede as string)),
);

reportsRouter.get(
  '/recaudo',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.recaudo(req.query.from as string, req.query.to as string, req.query.sede as string)),
);

reportsRouter.get(
  '/recaudo-funcionario',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.recaudoFuncionario(req.query.from as string, req.query.to as string, req.query.metodo as string, req.query.caja as string)),
);

reportsRouter.get(
  '/recaudo-funcionario/filtros',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.recaudoFuncionarioFiltros()),
);

reportsRouter.get(
  '/reincidencia',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.reincidencia(req.query.from as string, req.query.to as string, req.query.sede as string)),
);

reportsRouter.get(
  '/tecnicos',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.tecnicos(req.query.from as string, req.query.to as string, req.query.sede as string, req.query.tipo as string, req.query.prioridad as string)),
);

reportsRouter.get(
  '/tecnicos/:staffId',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.tecnico(req.params.staffId, req.query.from as string, req.query.to as string, req.query.sede as string, req.query.tipo as string, req.query.prioridad as string)),
);

reportsRouter.get(
  '/tendencias',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.tendencia(req.query.metrica as string, req.query.from as string, req.query.to as string, req.query.sede as string, req.query.agrupar as string)),
);

reportsRouter.get(
  '/tendencias/comparar',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.comparar(req.query.metrica as string, req.query.aDesde as string, req.query.aHasta as string, req.query.bDesde as string, req.query.bHasta as string, req.query.sede as string)),
);

reportsRouter.get(
  '/tendencias/metricas',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.metricasDisponibles()),
);

reportsRouter.get(
  '/top-deudores',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.topDeudores(req.query.sede as string)),
);

reportsRouter.get(
  '/ventas-sede',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => reports.ventasSede(req.query.from as string, req.query.to as string)),
);
