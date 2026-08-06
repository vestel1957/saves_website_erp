import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PlansService } from '../../plans/plans.service';
import { ConfigDataService } from '../../config/config.service';
import { ChatbotGateService } from '../chatbot-gate.service';
import { OFICINAS, PLANES_COMERCIALES } from '../tramites.catalogo';
import { cop, safe } from './toolset.util';

/**
 * Lo que la empresa le cuenta a CUALQUIERA que pregunte: qué planes hay, cuánto
 * valen, dónde quedan las oficinas y cómo se contacta a Vestel.
 *
 * Estaba dentro de `PublicoToolset`, y eso dejaba al agente de CLIENTES sin ello —
 * que es justo al revés de lo que hace falta. El abonado es quien pregunta "¿cuánto
 * me cuesta subirme a 600 megas?" y "¿a qué hora abren en Aguazul?", y el bot le
 * respondía que no tenía esa información teniendo el dato en el mismo proceso. Peor:
 * su propio prompt le mandaba usar `planes_disponibles` (y el guion del cambio de
 * plan también), así que el modelo intentaba llamar una herramienta que no existía
 * para él y acababa improvisando o rindiéndose delante del cliente.
 *
 * Nada de esto toca una cuenta ni recibe un identificador de cliente, así que se le
 * puede dar a los dos agentes de cara al cliente sin abrir ninguna puerta: es la
 * misma información que está publicada en la web y en la cartelera de la oficina.
 */
export class ComercialToolset implements Toolset {
  constructor(
    private readonly plans: PlansService,
    private readonly config: ConfigDataService,
    private readonly gate: ChatbotGateService,
  ) {}

  definitions(_ctx: ToolContext): ToolDef[] {
    return [
      {
        name: 'planes_disponibles',
        description:
          'Planes que la empresa ofrece hoy, con su velocidad y precio mensual, para hogar y para negocio. ' +
          'Úsala SIEMPRE que pregunten por planes, precios, "cuánto vale", "qué megas hay" o quieran cambiarse ' +
          'de plan: los precios salen de aquí y NUNCA de tu memoria.',
        input_schema: {
          type: 'object',
          properties: {
            tipo: { type: 'string', description: 'Filtrar por tipo de servicio (ej. INTERNET, TV). Opcional.' },
          },
        },
      },
      {
        name: 'sedes',
        description:
          'Oficinas de la empresa con su dirección, para atención presencial. Úsala cuando pregunten dónde ' +
          'quedan, dónde pagar o dónde hacer un trámite presencial. Menciónale SOLO la del municipio que le ' +
          'corresponde, no le leas la lista entera.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'datos_empresa',
        description: 'Datos de contacto de la empresa: nombre, dirección, teléfono y correo.',
        input_schema: { type: 'object', properties: {} },
      },
    ];
  }

  async execute(name: string, input: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
    switch (name) {
      case 'planes_disponibles':
        return safe(() => this.planes(input));
      case 'sedes':
        return safe(() => this.sedes());
      case 'datos_empresa':
        return safe(() => this.empresa());
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  /**
   * Los planes que se le ofrecen a quien pregunta por WhatsApp.
   *
   * Dos fuentes, en este orden:
   *
   *  1. Los planes que se hayan elegido en Configuración → Agente de WhatsApp. Es la
   *     vía preferida: el precio que se cotiza sale de la misma tabla que factura.
   *  2. Si no se ha elegido ninguno, el catálogo comercial 2026 (`PLANES_COMERCIALES`).
   *
   * La tabla `Plan` tiene 72 planes activos heredados del sistema viejo —tarifas
   * repetidas, de otras ciudades y cosas como "1 Mega por $20.000"—, y ninguno
   * corresponde a la oferta que la empresa publica hoy. Por eso el respaldo NO puede
   * ser "los primeros de la lista": eso es exactamente lo que hacía antes, y el bot
   * estuvo cotizándole tarifas muertas a cada interesado que escribió.
   */
  private async planes(input: Record<string, unknown>): Promise<string> {
    const kind = input.tipo ? String(input.tipo).toUpperCase() : undefined;

    // 1) Si en Configuración se eligieron planes de la BD, mandan esos: es la vía
    //    preferida, porque el precio que se cotiza sale del mismo sitio que factura.
    const elegidos = await this.gate.planesPublicos();
    if (elegidos.length) {
      const rows = await this.plans.list({ activeOnly: true, kind: kind as any });
      const curado = rows.filter((p) => elegidos.includes(p.id));
      // La lista puede quedar vacía si preguntan por un tipo que no se publicó
      // (p. ej. TV cuando solo se eligieron planes de internet).
      if (!curado.length) {
        return 'No tengo planes publicados de ese tipo. Ofrece los de internet o remite a una sede.';
      }
      return curado
        .map((p) => `• ${p.name} (${p.kind})${p.megas ? ` — ${p.megas} megas` : ''}: ${cop(p.price)}/mes`)
        .join('\n');
    }

    // 2) Sin elección, el catálogo comercial 2026 (ver PLANES_COMERCIALES).
    //
    //    Aquí estaba el peor fallo que ha tenido este bot: caía a "los primeros 12
    //    planes activos por orden alfabético" y le ofrecía a gente que quería comprar
    //    tarifas muertas del legacy — literalmente "1 Mega por $20.000" como primera
    //    opción. Se cotizaba mal a cada interesado que escribía.
    const listar = (segmento: 'residencial' | 'comercial') =>
      PLANES_COMERCIALES.filter((p) => p.segmento === segmento)
        .map((p) => `• ${p.nombre}: ${cop(p.precio)}/mes — ${p.incluye}`)
        .join('\n');

    return [
      'PLANES PARA EL HOGAR (fibra óptica, velocidad simétrica):',
      listar('residencial'),
      '',
      'PLANES PARA NEGOCIOS:',
      listar('comercial'),
      '',
      'Preséntale SOLO lo que le sirve —hogar o negocio—, NO le leas la lista entera. ' +
      'La afiliación se cobra aparte y depende de la permanencia: consúltala con info_comercial. ' +
      'Si lo que necesita es un enlace dedicado punto a punto para una empresa, eso no se cotiza por ' +
      'chat: mira info_comercial (tema dedicado) y pásalo a un asesor.',
    ].join('\n');
  }

  /**
   * Las oficinas, con dirección.
   *
   * MANDA EL CATÁLOGO (`OFICINAS`, del documento comercial de SAM) y la BD solo
   * rellena las sedes que no estén en él. Es al revés que con los planes, y es una
   * decisión explícita del negocio (2026-08-03): al cotejar las dos fuentes, dos de
   * las cinco direcciones NO coincidían —Yopal (BD «Diagonal 34 # 31B - 87» vs
   * documento «Carrera 20 #26-76») y Aguazul (BD «Calle 12 # 14 - 27» vs documento
   * «Carrera 14 #11-75»)—, y la buena es la del documento: la columna `dir` de
   * `Branch` viene del sistema viejo y arrastra direcciones de antes de los traslados.
   *
   * Aquí no hay término medio que valga: mandar a alguien a la oficina equivocada le
   * cuesta un viaje perdido, así que se elige una fuente y se respeta.
   *
   * La BD sigue sirviendo para lo suyo: qué sedes existen (`Mocoa`, `Villavicencio`
   * no están en el documento) y su dirección cuando el catálogo no la tiene.
   */
  private async sedes(): Promise<string> {
    const rows = await this.config.branches();
    if (!rows.length) {
      // Ni una sede en la BD: al menos que dé las direcciones que sí conocemos.
      return Object.entries(OFICINAS).map(([m, dir]) => `• ${this.titulo(m)} — ${dir}`).join('\n');
    }
    return rows
      .map((b) => `• ${b.name} — ${OFICINAS[this.municipio(b.name)] || b.dir || 'dirección no registrada'}`)
      .join('\n');
  }

  /**
   * De "CABECERA YOPAL" o "Almacen Villanueva" a la clave del catálogo. Se busca el
   * municipio DENTRO del nombre porque las sedes del legacy vienen con prefijos y
   * sufijos ("Almacen cabecera Yopal"), no con el nombre pelado.
   */
  private municipio(nombre: string): string {
    const limpio = nombre
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return Object.keys(OFICINAS).find((m) => limpio.includes(m)) ?? '';
  }

  private titulo(municipio: string): string {
    return municipio.charAt(0).toUpperCase() + municipio.slice(1);
  }

  private async empresa(): Promise<string> {
    const c = await this.config.company();
    if (!c) return 'No tengo los datos de contacto de la empresa a la mano.';
    return [
      c.name,
      c.address ? `Dirección: ${c.address}${c.city ? `, ${c.city}` : ''}` : '',
      c.phone ? `Teléfono: ${c.phone}` : '',
      c.email ? `Correo: ${c.email}` : '',
    ].filter(Boolean).join('\n');
  }
}
