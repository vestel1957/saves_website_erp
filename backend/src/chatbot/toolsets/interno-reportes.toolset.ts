import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportsService } from '../../reports/reports.service';
import { PerformanceService } from '../../reports/performance.service';
import { StaffReportsService } from '../../reports/staff-reports.service';
import { IspReportsService } from '../../reports/isp-reports.service';
import { MetricsService, METRICAS, ETIQUETA, ES_DINERO, NO_RECONSTRUIBLES } from '../../reports/metrics.service';
import { BillingService } from '../../billing/billing.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { ChatbotDocsService, enviarDoc, esReportePdf, REPORTES_PDF } from '../chatbot-docs.service';
import { canAny, cop, fecha, gated, REPORTES_PERMISOS, safe } from './toolset.util';

/** Reportes y dashboard son de gerencia, igual que en la web. */
const GERENCIA = REPORTES_PERMISOS;

/** Las claves de reporte, tal como se le ofrecen al modelo. */
const CLAVES = Object.keys(REPORTES_PDF);

/**
 * Indicadores para dirección: el resumen del negocio y los reportes, sin abrir el
 * portátil. Todo lectura.
 *
 * Cada reporte se puede pedir de dos formas: como CIFRAS en el chat (rápido, para
 * mirar de pasada) o como PDF adjunto (para leer, guardar o llevar a una reunión).
 * Las dos salen del mismo servicio: el PDF nunca puede decir algo distinto a lo que
 * el bot acaba de escribir en el chat.
 */
@Injectable()
export class InternoReportesToolset implements Toolset {
  constructor(
    private readonly reports: ReportsService,
    private readonly dashboard: DashboardService,
    private readonly performance: PerformanceService,
    private readonly staffReports: StaffReportsService,
    private readonly isp: IspReportsService,
    private readonly metrics: MetricsService,
    private readonly billing: BillingService,
    private readonly docs: ChatbotDocsService,
    // Solo para resolver el nombre de una sede a su id; los datos siguen saliendo
    // de los servicios de reportes, nunca de una consulta propia.
    private readonly prisma: PrismaService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    // Rango de fechas: lo comparten casi todos los reportes.
    const periodo = {
      desde: { type: 'string', description: 'YYYY-MM-DD' },
      hasta: { type: 'string', description: 'YYYY-MM-DD' },
    };
    // La sede la aceptan los reportes que cuelgan del abonado. Se pide por NOMBRE:
    // el modelo no tiene por qué conocer ids internos.
    const sedeProp = {
      sede: { type: 'string', description: 'Nombre de la sede (Villanueva, Yopal, Aguazul, Monterrey, Tauramena, Mocoa, Villavicencio). Vacío = todas.' },
    };

    return gated(canAny(ctx, GERENCIA), [
      {
        name: 'resumen_negocio',
        description:
          'Resumen general del negocio (dashboard): abonados, cartera, recaudo y tickets. Úsala para "cómo vamos", "resumen", "indicadores".',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'reporte_recaudo',
        description: 'Recaudo del periodo indicado, por caja y por método de pago. Se puede acotar a una SEDE.',
        input_schema: { type: 'object', properties: { ...periodo, ...sedeProp } },
      },
      {
        name: 'top_deudores',
        description: 'Abonados con mayor deuda acumulada. Se puede acotar a una SEDE.',
        input_schema: { type: 'object', properties: { ...sedeProp } },
      },
      {
        name: 'reporte_servicios',
        description:
          'Cómo está repartida la base de clientes HOY: cuántos activos, cortados, en cartera, etc., ' +
          'en total y por sede. Es una FOTO DEL MOMENTO, no una serie: no sirve para saber cuántos ' +
          'abonados había en una fecha pasada.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'reporte_cortes',
        description: 'Cortes, activaciones, suspensiones y retiros del periodo. Se puede acotar a una SEDE.',
        input_schema: { type: 'object', properties: { ...periodo, ...sedeProp } },
      },
      {
        /**
         * El reporte que más se pide de viva voz ("cómo van los técnicos", "quién
         * está rindiendo") y el único que no existía: por eso el bot respondía que
         * no tenía acceso a algo que en realidad nadie había construido.
         */
        name: 'reporte_tecnicos',
        description:
          'EL REPORTE DE RENDIMIENTO. Desempeño de cada persona de campo, una fila por técnico: órdenes ' +
          'asignadas, cerradas, abiertas, vencidas, re-visita a 15 días y ciclo. ' +
          'ES LA CORRECTA para CUALQUIER pedido de "rendimiento", "desempeño" o "cómo van/cómo está rindiendo" ' +
          'la gente, sin importar la palabra que usen para llamarlos: funcionarios, empleados, personal, ' +
          'trabajadores, operarios o técnicos son AQUÍ lo mismo. ' +
          'Sin fechas toma los últimos 90 días.',
        input_schema: { type: 'object', properties: periodo },
      },
      {
        name: 'reporte_ordenes',
        description:
          'ÓRDENES DE SERVICIO / de soporte técnico: cuántas hubo EN TOTAL y cuántas de CADA TIPO ' +
          '(instalación, reconexión, cambio de clave, revisión, corte, traslado…), más el reparto por estado ' +
          'y por técnico asignado. Se puede acotar A UNA SEDE con el parámetro sede (Villanueva, Yopal, ' +
          'Aguazul, Monterrey, Tauramena, Mocoa, Villavicencio). ' +
          'Es CANTIDAD de trabajo, no rendimiento (para eso usa reporte_tecnicos).',
        input_schema: {
          type: 'object',
          properties: {
            sede: { type: 'string', description: 'Nombre de la sede, p. ej. "Villanueva". Vacío = todas.' },
            ...periodo,
          },
        },
      },
      {
        name: 'reporte_ventas_sede',
        description: 'Lo FACTURADO por sede en el periodo (no es lo recaudado).',
        input_schema: { type: 'object', properties: periodo },
      },
      {
        name: 'reporte_ingresos_egresos',
        description: 'Ingresos contra egresos, mes a mes (últimos 12 meses con datos).',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'reporte_movimientos_clientes',
        description: 'Altas y retiros de clientes en el periodo, y el neto. Se puede acotar a una SEDE.',
        input_schema: { type: 'object', properties: { ...periodo, ...sedeProp } },
      },
      {
        name: 'reporte_facturacion',
        description:
          'Resumen de facturación: cuántas facturas se emitieron, cuánto se facturó, cuántas están pagadas ' +
          'o pendientes, y cuánta cartera quedó.',
        input_schema: { type: 'object', properties: periodo },
      },
      {
        name: 'reporte_iva',
        description:
          'Reporte de IVA para la declaración: base gravable, base exenta, IVA y retención por documento. ' +
          'De VENTAS (facturas a clientes) o de COMPRAS (órdenes a proveedores).',
        input_schema: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['ventas', 'compras'], description: 'Por defecto ventas' },
            ...periodo,
            ...sedeProp,
          },
        },
      },
      {
        name: 'reporte_recaudo_funcionario',
        description:
          'CUÁNTA PLATA entró por manos de cada funcionario: montos, movimientos y participación sobre el total. ' +
          'Es un reporte de DINERO, no de desempeño. ' +
          'OJO: si te piden el "rendimiento de los funcionarios" (o del personal, o de los empleados) NO es esta, ' +
          'es reporte_tecnicos; el parecido del nombre es una trampa. ' +
          'Usa esta SOLO si hablan explícitamente de recaudo, cobros o plata recibida.',
        input_schema: { type: 'object', properties: periodo },
      },
      {
        name: 'reporte_anulaciones',
        description:
          'Anulaciones de movimientos: quién anuló, cuánto y CUÁNTOS DÍAS DESPUÉS del cobro. ' +
          'Es un reporte de control. Úsala para "anulaciones", "quién está anulando". Se puede acotar a una SEDE.',
        input_schema: { type: 'object', properties: { ...periodo, ...sedeProp } },
      },
      {
        name: 'reporte_actividad',
        description:
          'Actividad registrada en el sistema (bitácora de auditoría): qué se tocó, por quién y en qué módulo. ' +
          'NO es todo lo que hizo el equipo y NO sirve para medir productividad.',
        input_schema: { type: 'object', properties: periodo },
      },
      {
        name: 'reporte_tecnico_detalle',
        description:
          'Detalle de UN técnico concreto: su desglose por tipo de trabajo y LAS ÓRDENES que trajeron queja del ' +
          'cliente (revisables de a una). Úsala cuando pregunten por una persona en particular ' +
          '("cómo va Oscar", "qué pasa con fulano"). Basta el nombre o parte de él.',
        input_schema: {
          type: 'object',
          properties: {
            tecnico: { type: 'string', description: 'Nombre del técnico (o parte)' },
            ...periodo,
          },
          required: ['tecnico'],
        },
      },
      {
        name: 'indice_recaudo',
        description:
          'De lo que se FACTURA, cuánto ENTRA de verdad, mes a mes. Es el indicador de salud de la cobranza. ' +
          'Úsala para "cómo va el recaudo contra lo facturado", "estamos cobrando bien". ' +
          'OJO: puede pasar del 100% cuando se recupera cartera vieja, y eso NO es un error.',
        input_schema: { type: 'object', properties: { ...periodo, ...sedeProp } },
      },
      {
        name: 'arpu',
        description:
          'ARPU: cuánto deja CADA abonado al mes (facturado y recaudado). Úsala para "cuánto vale un cliente", ' +
          '"cuánto factura en promedio cada abonado", "está subiendo el ticket".',
        input_schema: { type: 'object', properties: { ...periodo, ...sedeProp } },
      },
      {
        name: 'capacidad_red',
        description:
          'CAPACIDAD DE RED: puertos libres y ocupados por NAP, y qué cajas están llenas. ' +
          'Úsala para "dónde puedo instalar", "hay puertos disponibles en tal sede", ' +
          '"qué NAP hay que ampliar", "tenemos capacidad". Es una foto de hoy.',
        input_schema: { type: 'object', properties: { ...sedeProp } },
      },
      {
        name: 'reincidencia_cortes',
        description:
          'Clientes que entran en CICLO de corte y reconexión. Úsala para "quién se corta todos los meses", ' +
          '"clientes reincidentes", "quiénes están en ciclo de mora". Casi siempre es cobranza, no técnica.',
        input_schema: { type: 'object', properties: { ...periodo, ...sedeProp } },
      },
      {
        name: 'permanencia_clientes',
        description:
          'De los clientes que entraron cada año, cuántos siguen (retención) y qué antigüedad tienen los activos. ' +
          'Úsala para "cuánto nos duran los clientes", "retención", "antigüedad de la base".',
        input_schema: { type: 'object', properties: { ...sedeProp } },
      },
      {
        name: 'comparar_periodos',
        description:
          'COMPARATIVA HISTÓRICA: cuánto cambió un indicador entre dos periodos, con su variación. ' +
          'Úsala para "compárame junio con julio", "cómo vamos contra el año pasado", ' +
          '"cuántos abonados teníamos en enero y cuántos ahora", "ha subido o bajado el recaudo". ' +
          `Indicadores: ${Object.values(METRICAS).join(', ')}. ` +
          'El más útil para "cuántos clientes teníamos" es facturacion.abonados (base facturable), ' +
          'que es el ÚNICO con histórico fiable hacia atrás.',
        input_schema: {
          type: 'object',
          properties: {
            metrica: { type: 'string', enum: Object.values(METRICAS) },
            aDesde: { type: 'string', description: 'YYYY-MM-DD, inicio del PRIMER periodo' },
            aHasta: { type: 'string', description: 'YYYY-MM-DD' },
            bDesde: { type: 'string', description: 'YYYY-MM-DD, inicio del SEGUNDO periodo' },
            bHasta: { type: 'string', description: 'YYYY-MM-DD' },
            ...sedeProp,
          },
          required: ['metrica', 'aDesde', 'aHasta', 'bDesde', 'bHasta'],
        },
      },
      {
        name: 'tendencia',
        description:
          'EVOLUCIÓN de un indicador mes a mes (o día a día) en un rango. Úsala para ' +
          '"cómo viene el recaudo este año", "muéstrame la tendencia de la cartera", ' +
          '"la evolución de los abonados".',
        input_schema: {
          type: 'object',
          properties: {
            metrica: { type: 'string', enum: Object.values(METRICAS) },
            agrupar: { type: 'string', enum: ['mes', 'dia'], description: 'Por defecto mes.' },
            ...periodo,
            ...sedeProp,
          },
          required: ['metrica'],
        },
      },
      {
        name: 'desde_cuando_hay_datos',
        description:
          'Desde qué fecha hay histórico de cada indicador. Úsala ANTES de decir que un dato no existe: ' +
          'algunos se pueden ver desde 2022 y otros solo desde que se empezó a medir.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        /**
         * El PDF va con el MISMO gate que leer el reporte (gerencia), y no con el de
         * documentos (`DOCUMENTOS_PERMISOS`, administración). Es deliberado: aquel
         * gate protege documentos de un TERCERO —la factura de un cliente con su
         * dirección y su cédula, un contrato— que salen de la empresa en el celular
         * de quien los pide. Un reporte de gerencia es agregado interno, y quien ya
         * puede leer sus cifras en el chat puede copiarlas igual. Exigir aquí
         * administración dejaría a un gerente sin el PDF de su propio tablero, que
         * es exactamente la queja que originó esta herramienta.
         */
        name: 'enviar_pdf_reporte',
        description:
          'Genera un reporte en PDF y lo ADJUNTA A ESTE CHAT, con el membrete de la empresa. ' +
          'Úsala siempre que pidan un reporte "en PDF", "en documento", "para imprimir" o "para enviar". ' +
          'Es el mismo dato que devuelven las demás herramientas de reporte, pero como archivo. ' +
          `Reportes disponibles: ${Object.entries(REPORTES_PDF).map(([k, v]) => `${k} (${v})`).join(', ')}. ` +
          // Este desempate va aquí y no solo en las herramientas de consulta porque el
          // fallo real ocurrió eligiendo la CLAVE: pidieron "el rendimiento de los
          // funcionarios" y la clave que lleva la palabra "funcionario" es la de plata.
          'DESEMPATE IMPORTANTE: para el RENDIMIENTO o desempeño de la gente —los llamen funcionarios, ' +
          'empleados, personal o técnicos— la clave es "tecnicos", NUNCA "recaudo_funcionario" (esa es de ' +
          'cuánta plata recaudó cada uno). Si preguntan por UNA persona en concreto, usa "tecnico_detalle" ' +
          'con su nombre en el parámetro tecnico.',
        input_schema: {
          type: 'object',
          properties: {
            reporte: { type: 'string', enum: CLAVES, description: 'Cuál de los reportes' },
            tipo: { type: 'string', enum: ['ventas', 'compras'], description: 'Solo para el reporte "iva"' },
            tecnico: { type: 'string', description: 'Solo para "tecnico_detalle": nombre del técnico' },
            metrica: { type: 'string', enum: Object.values(METRICAS), description: 'Solo para "tendencias": qué indicador graficar.' },
            sede: { type: 'string', description: 'Sede por NOMBRE (Villanueva, Yopal…). La aceptan: ordenes, recaudo, deudores, cortes, movimientos, anulaciones e iva-de-ventas.' },
            ...periodo,
          },
          required: ['reporte'],
        },
      },
    ]);
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, GERENCIA)) return PERMISSION_DENIED;
    const desde = input.desde ? String(input.desde) : undefined;
    const hasta = input.hasta ? String(input.hasta) : undefined;

    // La sede llega por nombre en CUALQUIER reporte que la acepte. Se resuelve una
    // sola vez, aquí: si no existe o es ambigua se contesta eso y no se consulta
    // nada — un reporte de la sede equivocada tiene cifras verosímiles y no hay
    // forma de notarlo desde el chat.
    let sedeId: string | undefined;
    if (input.sede && name !== 'enviar_pdf_reporte') {
      const hallada = await this.resolverSede(String(input.sede));
      if (typeof hallada === 'string') return hallada;
      sedeId = hallada.id;
    }

    switch (name) {
      case 'resumen_negocio':
        return safe(async () => this.compacto(await this.dashboard.summary()));
      case 'reporte_recaudo':
        return safe(async () => this.compacto(await this.reports.recaudo(desde, hasta, sedeId)));
      case 'top_deudores':
        return safe(async () => this.deudores(await this.reports.topDeudores(sedeId)));
      case 'reporte_servicios':
        return safe(async () => this.estadoClientes(await this.reports.estadisticasServicios()));
      case 'reporte_cortes':
        return safe(async () => this.compacto(await this.reports.cortesActivaciones(desde, hasta, sedeId)));
      case 'reporte_tecnicos':
        return safe(async () => this.tecnicos(await this.performance.tecnicos(desde, hasta)));
      case 'reporte_ordenes':
        return safe(() => this.ordenes(sedeId, desde, hasta));
      case 'reporte_ventas_sede':
        return safe(async () => this.compacto(await this.reports.ventasSede(desde, hasta)));
      case 'reporte_ingresos_egresos':
        return safe(async () => this.compacto(await this.reports.ingresosEgresos()));
      case 'reporte_movimientos_clientes':
        return safe(async () => this.compacto(await this.reports.movimientos(desde, hasta, sedeId)));
      case 'reporte_facturacion':
        return safe(async () => this.compacto(await this.billing.stats({ from: desde, to: hasta })));
      case 'reporte_iva':
        return safe(async () => this.iva(await this.reports.iva(String(input.tipo ?? 'ventas'), desde, hasta, sedeId)));
      case 'reporte_recaudo_funcionario':
        return safe(async () => this.compacto(await this.staffReports.recaudoPorFuncionario(desde, hasta)));
      case 'reporte_anulaciones':
        return safe(async () => this.anulaciones(await this.staffReports.anulaciones(desde, hasta, undefined, sedeId)));
      case 'reporte_actividad':
        return safe(async () => this.actividad(await this.staffReports.actividadSistema(desde, hasta)));
      case 'reporte_tecnico_detalle':
        return safe(() => this.tecnicoDetalle(String(input.tecnico ?? ''), desde, hasta));
      case 'indice_recaudo':
        return safe(async () => this.indiceRecaudo(await this.isp.indiceRecaudo(desde, hasta, sedeId)));
      case 'arpu':
        return safe(async () => this.arpuTexto(await this.isp.arpu(desde, hasta, sedeId)));
      case 'capacidad_red':
        return safe(async () => this.capacidad(await this.isp.capacidadRed(sedeId)));
      case 'reincidencia_cortes':
        return safe(async () => this.reincidenciaTexto(await this.isp.reincidencia(desde, hasta, sedeId)));
      case 'permanencia_clientes':
        return safe(async () => this.permanenciaTexto(await this.isp.permanencia(sedeId)));
      case 'comparar_periodos':
        return safe(() => this.compararPeriodos(input, sedeId));
      case 'tendencia':
        return safe(() => this.tendencia(input, desde, hasta, sedeId));
      case 'desde_cuando_hay_datos':
        return safe(() => this.cobertura());
      case 'enviar_pdf_reporte':
        return safe(() => this.enviarPdf(input, ctx, desde, hasta));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async enviarPdf(
    input: Record<string, unknown>,
    ctx: ToolContext,
    desde?: string,
    hasta?: string,
  ): Promise<string> {
    const clave = String(input.reporte ?? '').trim().toLowerCase();
    // El modelo se inventa nombres de reporte con facilidad ("empleados", "cartera").
    // Devolverle la lista es lo que hace que reintente bien en vez de disculparse.
    if (!esReportePdf(clave)) {
      return `Ese reporte no existe. Los que puedo mandar en PDF son: ${CLAVES.join(', ')}. ` +
        'Elige el más parecido a lo que te pidieron y vuelve a intentarlo.';
    }

    // El detalle de un técnico necesita saber de QUIÉN: se resuelve aquí, con el
    // mismo emparejado por nombre que usa la herramienta de consulta, para que el
    // modelo no tenga que conocer ids internos.
    let staff: { staffId: string; nombre: string } | undefined;
    if (clave === 'tecnico_detalle') {
      const hallado = await this.resolverTecnico(String(input.tecnico ?? ''), desde, hasta);
      if (typeof hallado === 'string') return hallado;
      staff = hallado;
    }

    // La sede llega por nombre y se resuelve igual que el técnico: si no existe o es
    // ambigua, se dice y NO se manda nada. Un reporte de la sede equivocada tiene
    // cifras verosímiles y no hay forma de notarlo desde el chat.
    let sede: { id: string; nombre: string } | undefined;
    if (input.sede) {
      const hallada = await this.resolverSede(String(input.sede));
      if (typeof hallada === 'string') return hallada;
      sede = hallada;
    }

    const doc = await this.docs.reporte(clave, {
      desde, hasta, quien: ctx.user.name,
      tipo: input.tipo ? String(input.tipo) : undefined,
      staffId: staff?.staffId, staffNombre: staff?.nombre,
      sedeId: sede?.id,
      metrica: input.metrica ? String(input.metrica) : undefined,
    });
    await ctx.audit({
      userId: ctx.user.id,
      action: 'reports.pdf.whatsapp',
      summary: `Reporte "${REPORTES_PDF[clave]}" enviado en PDF por WhatsApp`,
      detail: { reporte: clave, desde, hasta, tipo: input.tipo, tecnico: staff?.nombre, sede: sede?.nombre },
    });

    // Se le dicta al modelo CÓMO confirmarlo, con el nombre oficial del reporte. Es
    // la única defensa contra el fallo silencioso: cuando el bot mandó "Recaudo por
    // funcionario" creyendo que era el rendimiento, lo anunció con las palabras de
    // quien preguntó ("el PDF del rendimiento de los funcionarios") y el error no se
    // vio hasta abrir el archivo. Diciendo el nombre real, un reporte equivocado se
    // caza en el mismo mensaje.
    const nombre = REPORTES_PDF[clave] + (staff ? ` — ${staff.nombre}` : '') +
      (sede ? ` — sede ${sede.nombre}` : '') +
      (clave === 'iva' ? ` (${input.tipo ?? 'ventas'})` : '');
    return enviarDoc(ctx, doc,
      `Listo: quedó adjunto en este chat el reporte "${nombre}", periodo ${doc.caption.split(' · ').pop()}. ` +
      `Confírmaselo en UNA línea nombrándolo EXACTAMENTE así: "${nombre}". ` +
      'NO lo describas con las palabras que usó él ni te inventes otro título: si el reporte no era el que quería, tiene que poder notarlo sin abrir el archivo. ' +
      'No repitas el contenido del documento.');
  }

  /**
   * Nombre suelto → técnico del tablero.
   *
   * Se busca contra los técnicos QUE APARECEN EN EL PERIODO, no contra toda la
   * ficha de personal: pedir "el detalle de Pedro" cuando Pedro no tuvo órdenes
   * debe responder eso, no un reporte vacío que parece un fallo. Ante varios
   * candidatos no se adivina —se listan—: mandar el desempeño de la persona
   * equivocada es de las cosas más difíciles de deshacer.
   */
  private async resolverTecnico(
    nombre: string,
    desde?: string,
    hasta?: string,
  ): Promise<{ staffId: string; nombre: string } | string> {
    const q = this.normalizar(nombre);
    if (!q) return 'Dime de qué técnico quieres el detalle.';

    const tablero: any = await this.performance.tecnicos(desde, hasta);
    const todos: any[] = tablero.tecnicos ?? [];
    if (!todos.length) return 'En ese periodo ningún técnico tuvo órdenes de campo asignadas.';

    const calzan = todos.filter((t) => this.normalizar(t.nombre).includes(q));
    if (!calzan.length) {
      return `No encuentro a "${nombre}" entre los técnicos con órdenes en ese periodo. ` +
        `Los que hay son: ${todos.map((t) => t.nombre).join(', ')}.`;
    }
    if (calzan.length > 1) {
      return `Hay varios que calzan con "${nombre}": ${calzan.map((t) => t.nombre).join(', ')}. ` +
        'Pregúntale a cuál se refiere antes de mandar nada.';
    }
    return { staffId: calzan[0].staffId, nombre: calzan[0].nombre };
  }

  /**
   * Órdenes de servicio, con el desglose por tipo COMPLETO.
   *
   * No usa `compacto` (el JSON crudo) porque el catálogo tiene 63 tipos y se pasaba
   * del recorte de 2.500 caracteres justo por la cola, que es donde están los tipos
   * raros que uno busca. Se redacta aquí, ordenado y con el total delante.
   */
  private async ordenes(sedeId?: string, desde?: string, hasta?: string): Promise<string> {
    const d: any = await this.reports.ordenes(desde, hasta, sedeId);
    if (!d.total) {
      return `No hay órdenes en ese periodo${d.sede ? ` en la sede ${d.sede}` : ''}.`;
    }

    const tipos = (d.porTipo ?? []).map((t: any) => `• ${t.tipo}: ${t.count}`);
    const estados = (d.porEstado ?? []).map((e: any) => `${e.estado} ${e.count}`).join(' · ');

    return [
      `Órdenes de servicio${d.sede ? ` · sede ${d.sede}` : ' · todas las sedes'} · ${fecha(desde)} a ${fecha(hasta)}`,
      `TOTAL: ${d.total} orden(es), de ${tipos.length} tipo(s) distintos.`,
      `Por estado: ${estados}`,
      `Por tipo (todos):\n${tipos.join('\n')}`,
      d.sinAbonado
        ? `Ojo: ${d.sinAbonado} orden(es) del periodo no tienen abonado, así que no tienen sede y no están contadas.`
        : '',
      'Preséntale el TOTAL primero y luego el desglose por tipo completo, sin recortar la lista.',
    ].filter(Boolean).join('\n');
  }

  /**
   * Nombre suelto → sede.
   *
   * Mismo criterio que con los técnicos: ante varias no se adivina. Mandar el reporte
   * de la sede equivocada es un error que no se ve —las cifras parecen razonables— y
   * es justo lo que pasó cuando se pidió "las órdenes de Villanueva" y llegó otra cosa.
   */
  private async resolverSede(nombre: string): Promise<{ id: string; nombre: string } | string> {
    const q = this.normalizar(nombre);
    const sedes = await this.prisma.branch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const calzan = sedes.filter((b) => this.normalizar(b.name).includes(q));

    if (!calzan.length) {
      return `No tenemos ninguna sede que se llame "${nombre}". Las sedes son: ${sedes.map((b) => b.name).join(', ')}.`;
    }
    if (calzan.length > 1) {
      return `"${nombre}" calza con varias sedes: ${calzan.map((b) => b.name).join(', ')}. Pregúntale a cuál se refiere.`;
    }
    return { id: calzan[0].id, nombre: calzan[0].name };
  }

  /** Sin tildes, sin mayúsculas y sin espacios de más: los nombres llegan como sea. */
  private normalizar(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private async tecnicoDetalle(nombre: string, desde?: string, hasta?: string): Promise<string> {
    const hallado = await this.resolverTecnico(nombre, desde, hasta);
    if (typeof hallado === 'string') return hallado;

    const d: any = await this.performance.tecnico(hallado.staffId, desde, hasta);
    const r = d.resumen;
    if (!r) return `${hallado.nombre} no tiene órdenes de campo en ese periodo.`;

    const tipos = (d.porTipo ?? []).slice(0, 6)
      .map((t: any) => `• ${t.tipo}: ${t.cerradas} cerradas, re-visita ${t.revisitaPct ?? '—'}%`);
    const casos = (d.casos ?? []).slice(0, 5)
      .map((c: any) => `• Orden ${c.code ?? '—'} (${fecha(c.fecha)}, ${c.tipo}) · ${c.cliente ?? `abonado ${c.abonado}`} volvió por "${c.queja}"`);

    return [
      `${hallado.nombre} · ${fecha(d.desde)} a ${fecha(d.hasta)}`,
      `${r.cerradas} cerradas de ${r.asignadas} asignadas · re-visita ${r.revisitaPct ?? '—'}% ` +
      `(mediana del equipo ${d.equipo?.medianaRevisita ?? '—'}%) · ${r.abiertas} abiertas, ${r.vencidas} vencidas.`,
      tipos.length ? `Por tipo de trabajo:\n${tipos.join('\n')}` : '',
      casos.length
        ? `Órdenes que trajeron queja (${d.casos.length} en total):\n${casos.join('\n')}`
        : 'Ninguna de sus órdenes cerradas trajo queja del mismo cliente.',
      r.muestraSuficiente
        ? 'Preséntalo como hechos revisables, no como una calificación.'
        : 'OJO: cerró muy pocas órdenes, sus porcentajes NO son interpretables. Dilo explícitamente.',
    ].filter(Boolean).join('\n');
  }

  private indiceRecaudo(d: any): string {
    const t = d.totales ?? {};
    const meses = (d.items ?? []).slice(-6).map((r: any) => `• ${r.mes}: facturado ${cop(r.facturado)} · recaudado ${cop(r.recaudado)} · ${r.indice}%`);
    return [
      `Índice de recaudo${d.sede ? ` · ${d.sede}` : ''} · ${fecha(d.desde)} a ${fecha(d.hasta)}`,
      `TOTAL: se facturó ${cop(t.facturado)} y entró ${cop(t.recaudado)} → índice ${t.indice}%.`,
      meses.join('\n'),
      'Explica SIEMPRE que por encima del 100% no es un error: significa que se está cobrando cartera vieja además de lo del mes.',
    ].filter(Boolean).join('\n');
  }

  private arpuTexto(d: any): string {
    const r = d.resumen ?? {};
    const meses = (d.items ?? []).slice(-6).map((x: any) => `• ${x.mes}: ${x.abonados} abonados · recaudado ${cop(x.arpuRecaudado)} · facturado ${cop(x.arpuFacturado)}`);
    return [
      `ARPU${d.sede ? ` · ${d.sede}` : ''} · ${fecha(d.desde)} a ${fecha(d.hasta)}`,
      `Último mes (${r.ultimoMes}): ${cop(r.arpuActual)} recaudado por abonado sobre ${r.abonadosActual} abonados.`,
      meses.join('\n'),
      'El divisor son los abonados FACTURADOS del mes, no los "activos" (ese dato histórico no es fiable). Dilo si preguntan de dónde sale.',
    ].filter(Boolean).join('\n');
  }

  private capacidad(d: any): string {
    const r = d.resumen ?? {};
    const sedes = (d.porSede ?? []).map((s: any) => `• ${s.sede}: ${s.libres} libres, ${s.ocupados} ocupados, ${s.saturadas} NAP(s) llenas`);
    const top = (d.criticas ?? []).slice(0, 8).map((n: any) => `• ${n.nap} (${n.sede}${n.direccion ? `, ${n.direccion}` : ''}): ${n.ocupados} ocupados, ${n.libres} libres`);
    return [
      `Capacidad de red${d.sede ? ` · ${d.sede}` : ''} — foto de hoy`,
      `${r.libres} puertos libres y ${r.ocupados} ocupados (${r.ocupacionPct}% de ocupación) en ${r.napsConInventario} NAPs.`,
      `${r.saturadas} NAP(s) sin un solo puerto libre y ${r.casiLlenas} por encima del 90%.`,
      sedes.length ? `Por sede:\n${sedes.join('\n')}` : '',
      top.length ? `Las que hay que ampliar primero:\n${top.join('\n')}` : '',
      r.sinInventario ? `${r.sinInventario} NAP(s) no tienen puertos registrados: no se sabe si están llenas, y NO cuentan como disponibles.` : '',
    ].filter(Boolean).join('\n');
  }

  private reincidenciaTexto(d: any): string {
    const r = d.resumen ?? {};
    if (!r.clientes) return 'No hubo reconexiones en ese periodo.';
    const top = (d.items ?? []).slice(0, 8).map((c: any) => `• ${c.cliente} (${c.sede}): ${c.reconexiones} reconexiones · debe ${cop(c.deuda)}`);
    return [
      `Reincidencia de cortes${d.sede ? ` · ${d.sede}` : ''} · ${fecha(d.desde)} a ${fecha(d.hasta)}`,
      `${r.clientes} cliente(s) tuvieron al menos una reconexión, con ${r.reconexiones} reconexiones y ${r.cortes} cortes en total.`,
      `${r.cronicos} son CRÓNICOS (3 o más) y entre ellos deben ${cop(r.deudaCronicos)}.`,
      top.length ? `Los que más:\n${top.join('\n')}` : '',
      'Preséntalo como un asunto de COBRANZA, no técnico: a un cliente que se corta cada mes no se le arregla cambiándole el equipo.',
    ].filter(Boolean).join('\n');
  }

  private permanenciaTexto(d: any): string {
    const r = d.resumen ?? {};
    const co = (d.cohortes ?? []).slice(-8).map((c: any) => `• ${c.anio}: entraron ${c.ingresaron}, siguen ${c.activos} (${c.retencionPct}%)`);
    return [
      `Permanencia de clientes${d.sede ? ` · ${d.sede}` : ''} — foto de hoy`,
      `Antigüedad media de los activos: ${Math.round((r.antiguedadMediaMeses ?? 0) / 12 * 10) / 10} años.`,
      co.length ? `Por año de ingreso:\n${co.join('\n')}` : '',
      'Advierte que los años recientes tienen retención alta por definición (han tenido menos tiempo para irse) y que esto mide quién SIGUE, no cuándo se fue.',
    ].filter(Boolean).join('\n');
  }

  /** Formatea el valor de una métrica según sea plata o cuenta. */
  private valorMetrica(metrica: string, v: number | null): string {
    if (v == null) return 'sin dato';
    return ES_DINERO.has(metrica) ? cop(v) : new Intl.NumberFormat('es-CO').format(Math.round(v));
  }

  /**
   * La comparativa entre dos periodos: el "cuántos teníamos y cuántos tenemos".
   *
   * Si a un lado le falta histórico se dice y NO se calcula variación: comparar
   * contra un periodo sin datos daría una caída del 100% que nunca ocurrió, y esa
   * cifra tiene toda la pinta de ser cierta.
   */
  private async compararPeriodos(input: Record<string, unknown>, sedeId?: string): Promise<string> {
    const metrica = String(input.metrica ?? '');
    const c: any = await this.metrics.comparar(
      metrica,
      { desde: String(input.aDesde ?? ''), hasta: String(input.aHasta ?? '') },
      { desde: String(input.bDesde ?? ''), hasta: String(input.bHasta ?? '') },
      sedeId,
    );
    if (c.aviso && (c.a.valor == null || c.b.valor == null)) {
      return `${c.etiqueta}: ${c.aviso} Dilo tal cual, sin estimar el dato que falta.`;
    }
    const signo = (c.diferencia ?? 0) > 0 ? '+' : '';
    return [
      `${c.etiqueta}${sedeId ? ' (sede filtrada)' : ''}`,
      `• ${fecha(c.a.desde)} a ${fecha(c.a.hasta)}: ${this.valorMetrica(metrica, c.a.valor)}`,
      `• ${fecha(c.b.desde)} a ${fecha(c.b.hasta)}: ${this.valorMetrica(metrica, c.b.valor)}`,
      `• Diferencia: ${signo}${this.valorMetrica(metrica, c.diferencia)}` +
        (c.variacionPct != null ? ` (${signo}${c.variacionPct}%)` : ''),
      c.aviso ? `OJO: ${c.aviso}` : '',
    ].filter(Boolean).join('\n');
  }

  private async tendencia(input: Record<string, unknown>, desde?: string, hasta?: string, sedeId?: string): Promise<string> {
    const metrica = String(input.metrica ?? '');
    // Sin rango: el año en curso, que es lo que se pregunta el 90% de las veces.
    const hoy = new Date().toISOString().slice(0, 10);
    const d = desde ?? `${hoy.slice(0, 4)}-01-01`;
    const h = hasta ?? hoy;
    const serie: any[] = await this.metrics.serie(metrica, d, h, {
      sede: sedeId, agrupar: input.agrupar === 'dia' ? 'dia' : 'mes',
    });
    if (!serie.length) {
      const cob: any[] = await this.metrics.cobertura();
      const c = cob.find((x) => x.metrica === metrica);
      const alternativa = NO_RECONSTRUIBLES.includes(metrica)
        ? ` Para saber cuántos clientes había en una fecha pasada usa "${METRICAS.BASE_FACTURABLE}" (base facturable),` +
          ' que sí tiene histórico fiable desde 2022; explícale que mide abonados facturados en el mes, no estado ACTIVO.'
        : '';
      return `No hay datos de "${ETIQUETA[metrica] ?? metrica}" en ese rango.` +
        (c ? ` De ese indicador hay histórico desde ${c.desde}.` : ' De ese indicador todavía no hay histórico.') +
        alternativa;
    }
    const lineas = serie.map((p) => `• ${p.fecha.slice(0, 7)}: ${this.valorMetrica(metrica, p.valor)}`);
    const primero = serie[0].valor, ultimo = serie[serie.length - 1].valor;
    const var_ = primero ? Math.round(((ultimo - primero) / primero) * 1000) / 10 : null;
    return [
      `${ETIQUETA[metrica] ?? metrica} · ${fecha(d)} a ${fecha(h)}`,
      lineas.join('\n'),
      var_ != null ? `Del primer al último periodo: ${var_ > 0 ? '+' : ''}${var_}%.` : '',
    ].filter(Boolean).join('\n');
  }

  private async cobertura(): Promise<string> {
    const c: any[] = await this.metrics.cobertura();
    if (!c.length) return 'Todavía no hay histórico guardado.';
    const rec = c.filter((x) => x.reconstruible).map((x) => `• ${x.etiqueta}: desde ${x.desde}`);
    const no = c.filter((x) => !x.reconstruible).map((x) => `• ${x.etiqueta}: desde ${x.desde}`);
    return [
      'Histórico disponible:',
      rec.length ? `Reconstruido desde los documentos (fiable):\n${rec.join('\n')}` : '',
      no.length
        ? `Fotografiado a diario desde que se empezó a medir (NO se puede reconstruir antes):\n${no.join('\n')}`
        : '',
      'Si te piden un dato anterior a esas fechas, dilo con franqueza en vez de estimarlo.',
    ].filter(Boolean).join('\n');
  }

  /**
   * Estado de la base de clientes HOY.
   *
   * Lleva pegada la advertencia de que NO hay histórico fiable, y va aquí y no en el
   * prompt porque es donde el modelo la lee justo cuando le acaban de preguntar
   * "¿cuántos activos teníamos a principio de año?". Sin ella, el modelo mandaba
   * este mismo reporte diciendo que "incluye la cantidad de usuarios a inicio de
   * año" —que no la incluye— o le pedía la cifra al propio funcionario para
   * "calcularla".
   *
   * Y no es que falte construir la consulta: `SubscriberStatusHistory` NO registra
   * todos los cambios. En 1.482 de 12.142 abonados con historial (12%) el último
   * estado registrado no coincide con el estado real, así que reconstruir una fecha
   * pasada da una cifra con aspecto de exacta y ~12% de desvío. Es peor que no darla.
   */
  private estadoClientes(d: any): string {
    const estados = Object.entries(d.estados ?? {})
      .sort((a: any, b: any) => b[1] - a[1])
      .map(([e, n]) => `• ${e}: ${n}`);
    const sedes = (d.porSede ?? [])
      .map((s: any) => `• ${s.sede}: ${s.total} (${s.activos} activos, ${s.cortados} cortados, ${s.cartera} cartera)`);

    return [
      `Estado de la base de clientes — FOTO DE HOY (${fecha(new Date())}):`,
      estados.join('\n'),
      sedes.length ? `Por sede:\n${sedes.join('\n')}` : '',
      'ADVERTENCIA que debes trasladar si te preguntan por una FECHA PASADA ("cuántos activos teníamos a principio de año", "hace seis meses"): ' +
      'estas cifras son de HOY y el sistema NO guarda un histórico fiable del estado de los abonados, así que ese dato NO se puede sacar. ' +
      'Dilo con franqueza, NO lo estimes, NO se lo preguntes al funcionario y NO digas que este reporte lo incluye. ' +
      'Lo que sí puedes ofrecerle es el reporte de altas y retiros del periodo, que mide el MOVIMIENTO (cuántos entraron y cuántos se fueron).',
    ].filter(Boolean).join('\n');
  }

  /**
   * El IVA no se puede soltar en JSON: el detalle son miles de documentos y lo que
   * se declara son los totales. Se entregan esos y el resumen por tarifa.
   */
  private iva(d: any): string {
    const t = d.totales ?? {};
    const tarifas = (d.porTarifa ?? [])
      .map((r: any) => `• ${r.tarifa}%: base ${cop(r.base)}, IVA ${cop(r.iva)} (${r.documentos} doc.)`);
    return [
      `IVA de ${d.tipo === 'compras' ? 'COMPRAS' : 'VENTAS'} · ${t.documentos ?? 0} documento(s)`,
      `• Base gravable: ${cop(t.baseGravable)}`,
      `• Base exenta: ${cop(t.baseExenta)}`,
      `• IVA: ${cop(t.iva)}`,
      `• Ajustes (notas crédito/débito): ${cop(t.ajustes)}`,
      `• Retención: ${cop(t.retencion)}`,
      `• Total: ${cop(t.total)}`,
      tarifas.length ? `Por tarifa:\n${tarifas.join('\n')}` : '',
      'Excluye documentos anulados. El detalle documento por documento va en el PDF o se exporta desde el ERP.',
    ].filter(Boolean).join('\n');
  }

  private anulaciones(d: any): string {
    if (!d.total) return 'No hubo anulaciones en ese periodo.';
    const quienes = (d.porQuien ?? []).slice(0, 8)
      .map((r: any) => `• ${r.quien}: ${r.n} por ${cop(r.monto)}` +
        `${r.maxDias > 7 ? ` (la peor, ${r.maxDias} días después del cobro)` : ''}`);
    return [
      `${d.total} anulación(es) por ${cop(d.monto)} · ${fecha(d.desde)} a ${fecha(d.hasta)}`,
      `Es el ${d.tasaPct}% de los ${d.movimientosPeriodo} movimientos del periodo.`,
      `Tardías (más de 7 días después del cobro): ${d.tardias?.total ?? 0} por ${cop(d.tardias?.monto)}.`,
      quienes.length ? `Por funcionario:\n${quienes.join('\n')}` : '',
      'Lo que importa aquí no es el número sino la DEMORA: anular algo del mismo día es corrección normal; anular un recibo viejo, no.',
    ].filter(Boolean).join('\n');
  }

  private actividad(d: any): string {
    if (!d.total) return 'No hay actividad registrada en la bitácora para ese periodo.';
    const usuarios = (d.porUsuario ?? []).slice(0, 8).map((r: any) => `• ${r.nombre}: ${r.eventos}`);
    const modulos = (d.porModulo ?? []).slice(0, 8).map((r: any) => `• ${r.modulo}: ${r.eventos}`);
    return [
      `${d.total} evento(s) en la bitácora · ${fecha(d.desde)} a ${fecha(d.hasta)}`,
      usuarios.length ? `Por usuario:\n${usuarios.join('\n')}` : '',
      modulos.length ? `Por módulo:\n${modulos.join('\n')}` : '',
      d.truncado ? 'OJO: se alcanzó el tope de lectura, faltan eventos por contar. Pide un rango más corto.' : '',
      'ADVERTENCIA que debes trasladar: la bitácora solo registra unas pocas entidades. Esto NO es todo lo que hizo el equipo y NO sirve para medir productividad ni comparar personas.',
    ].filter(Boolean).join('\n');
  }

  /**
   * El rendimiento de técnicos NO se entrega como JSON compacto: es el reporte con
   * más letra chica del ERP (mide re-visita, no volumen; hay quien no tiene muestra
   * suficiente) y soltarle la estructura cruda al modelo terminaba en un ranking de
   * "quién cerró más órdenes", que es justo lo contrario de lo que mide.
   */
  private tecnicos(d: any): string {
    const eq = d.equipo;
    if (!d.tecnicos?.length) return 'Nadie tuvo órdenes de campo asignadas en ese periodo.';

    const orden = [...d.tecnicos].sort((a: any, b: any) => {
      if (a.muestraSuficiente !== b.muestraSuficiente) return a.muestraSuficiente ? -1 : 1;
      return (b.revisitaPct ?? -1) - (a.revisitaPct ?? -1);
    });

    const lineas = orden.slice(0, 12).map((t: any) => {
      const rev = t.revisitaPct == null ? 'sin cerradas' : `re-visita ${t.revisitaPct}%`;
      const poca = t.muestraSuficiente ? '' : ' (muestra corta: no concluyas nada de su %)';
      return `• ${t.nombre}: ${t.cerradas} cerradas, ${rev}` +
        `${t.abiertas ? `, ${t.abiertas} abiertas` : ''}${t.vencidas ? ` (${t.vencidas} vencidas)` : ''}${poca}`;
    });

    return [
      `Rendimiento de técnicos · ${fecha(d.desde)} a ${fecha(d.hasta)}`,
      lineas.join('\n'),
      eq
        ? `Equipo: ${eq.cerradas} órdenes cerradas, re-visita ${eq.revisitaPct ?? '—'}% ` +
          `(mediana ${eq.medianaRevisita ?? '—'}%), ${eq.abiertas} abiertas y ${eq.vencidas} vencidas.`
        : '',
      `Mide solo TRABAJO DE CAMPO (no cortes automáticos) y la métrica que manda es la re-visita a ${eq?.ventanaRevisitaDias ?? 15} días, no el volumen. ` +
      `${d.sinAtribuir ?? 0} orden(es) del periodo no tienen técnico asignado.`,
      'Preséntalo como hechos, NO como un ranking ni una calificación de personas, y avisa que quien tiene muestra corta no es comparable.',
    ].filter(Boolean).join('\n');
  }

  private async deudores(rows: any): Promise<string> {
    const items: any[] = Array.isArray(rows) ? rows : (rows?.items ?? []);
    if (!items.length) return 'No hay deudores registrados.';
    return items.slice(0, 10)
      .map((d, i) => `${i + 1}. ${d.name ?? d.cliente ?? '—'} — ${cop(d.debt ?? d.total ?? d.deuda)}`)
      .join('\n');
  }

  /**
   * Los reportes devuelven estructuras distintas (series, agregados, listas). En vez
   * de un formateador por reporte —que se desincroniza en cuanto alguien toque uno—
   * se entrega el JSON compacto y el modelo lo redacta. Se recorta para no reventar
   * el contexto con series largas.
   */
  private compacto(data: unknown): string {
    const json = JSON.stringify(data, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
    const max = 2500;
    return json.length > max
      ? `${json.slice(0, max)}… (recortado; pide un periodo más corto para el detalle)`
      : json;
  }
}
