import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AgentEngine, type AgentResolver, type AgentUser, type AuditEntry } from '@s4gk/wa-agent';
import { OpenAiProvider } from '@s4gk/wa-agent/openai';
import { WhisperTranscriber } from '@s4gk/wa-agent/whisper';
import OpenAI from 'openai';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { ChatbotGateService } from './chatbot-gate.service';
import { ChatbotSessionStore } from './chatbot-session.store';
import { ChatbotUsageService } from './chatbot-usage.service';
import { SavesTransport } from './saves-transport';
import { ChatbotIdentityService } from './chatbot-identity.service';
import { AGENT_CLIENTE, AGENT_INTERNO, AGENT_PUBLICO, identityOf } from './chatbot.identity';
import { promptCliente, promptInterno, promptPublico } from './chatbot.prompts';
import { combineToolsets } from './toolsets/toolset.util';
import { InternoAbonadosToolset } from './toolsets/interno-abonados.toolset';
import { InternoTicketsToolset } from './toolsets/interno-tickets.toolset';
import { InternoRedToolset } from './toolsets/interno-red.toolset';
import { InternoInventarioToolset } from './toolsets/interno-inventario.toolset';
import { InternoCajaToolset } from './toolsets/interno-caja.toolset';
import { InternoReportesToolset } from './toolsets/interno-reportes.toolset';
import { ClienteToolset } from './toolsets/cliente.toolset';
import { PublicoToolset } from './toolsets/publico.toolset';

/**
 * Arma y arranca el agente de WhatsApp sobre @s4gk/wa-agent.
 *
 * Tres agentes lógicos comparten un solo motor, un solo transporte y un solo
 * proveedor LLM; lo único que cambia entre ellos es el prompt y el toolset:
 *
 *   soporte-interno → funcionario (hereda su RBAC real del ERP)
 *   clientes        → abonado identificado por su teléfono
 *   publico         → número desconocido (solo info comercial)
 *
 * Está apagado por omisión (WA_AGENT_ENABLED). Apagado, esta clase no construye
 * nada y el WhatsappService sigue enviando alertas y campañas como siempre: el
 * chatbot es aditivo, no cambia el comportamiento existente.
 */
@Injectable()
export class ChatbotService implements OnModuleInit {
  private readonly logger = new Logger('Chatbot');
  private engine: AgentEngine | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly whatsapp: WhatsappService,
    private readonly gate: ChatbotGateService,
    private readonly store: ChatbotSessionStore,
    private readonly usage: ChatbotUsageService,
    private readonly transport: SavesTransport,
    private readonly identity: ChatbotIdentityService,
    private readonly abonados: InternoAbonadosToolset,
    private readonly tickets: InternoTicketsToolset,
    private readonly red: InternoRedToolset,
    private readonly inventario: InternoInventarioToolset,
    private readonly caja: InternoCajaToolset,
    private readonly reportes: InternoReportesToolset,
    private readonly cliente: ClienteToolset,
    private readonly publico: PublicoToolset,
  ) {}

  /**
   * El motor se MONTA siempre que haya API key del LLM, encendido o no. Quien decide
   * si atiende cada mensaje es el ChatbotGateService, en el transporte. Así el
   * interruptor de Configuración surte efecto en segundos, sin reiniciar el backend:
   * apagar el bot con `pm2 restart` no sirve cuando hay clientes escribiendo.
   * Montado y apagado no cuesta nada: ningún mensaje llega al motor.
   */
  async onModuleInit(): Promise<void> {
    if (!process.env.OPENAI_API_KEY) {
      this.logger.warn('OPENAI_API_KEY no configurada: el agente NO se monta.');
      return;
    }

    const internoToolset = combineToolsets(
      this.abonados, this.tickets, this.red, this.inventario, this.caja, this.reportes,
    );

    this.engine = new AgentEngine({
      provider: new OpenAiProvider({
        model: process.env.WHATSAPP_BOT_MODEL ?? 'gpt-4o-mini',
        // Cliente propio SOLO para acotar el tiempo. Sin esto se heredan los valores
        // del SDK —timeout 10 min y 2 reintentos— y un turno puede colgarse ~30 min;
        // y como el motor encadena hasta 6 vueltas de herramientas, el techo es
        // absurdo. Nadie espera eso en WhatsApp: mejor fallar rápido y que el motor
        // responda "tuve un problema" que dejar al cliente mirando el chat.
        // `instrument` además contabiliza los tokens: el `usage` de OpenAI solo existe
        // aquí, porque el adaptador del motor lo descarta al normalizar la respuesta.
        client: this.usage.instrument(new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          timeout: Number(process.env.WHATSAPP_BOT_TIMEOUT_MS ?? 45_000),
          maxRetries: 1,
        })),
      }),
      transports: [this.transport],
      identity: this.identity,

      // Estado en BD, no en memoria: una confirmación pendiente tiene que sobrevivir
      // a un `pm2 restart` y ser visible desde cualquier worker. Con el almacén por
      // defecto, reiniciar entre "¿confirmas?" y el "SÍ" perdía la acción.
      store: this.store,
      transcriber: new WhisperTranscriber({ model: process.env.WHATSAPP_STT_MODEL ?? 'whisper-1', language: 'es' }),

      // Agente por defecto = el PÚBLICO (el de menos privilegio). El motor cae aquí
      // si el resolver devolviera un nombre desconocido, así que un error de
      // enrutado degrada a "solo info comercial" en vez de a algo peligroso.
      systemPrompt: promptPublico,
      toolsets: [this.publico],

      agents: [
        { name: AGENT_INTERNO, systemPrompt: promptInterno, toolset: internoToolset },
        { name: AGENT_CLIENTE, systemPrompt: promptCliente, toolset: this.cliente },
        { name: AGENT_PUBLICO, systemPrompt: promptPublico, toolset: this.publico },
      ],
      agentResolver: this.agentResolver(),

      // La pregunta de confirmación sale tal cual del `summary` que armó la
      // herramienta: ahorra una vuelta completa al LLM (~0,5–1 s en cada escritura)
      // y —más importante— garantiza que lo que el usuario confirma es literalmente
      // lo que se va a ejecutar, sin que el modelo lo reformule.
      confirmPrompt: (pending) => pending.summary,

      audit: (entry) => this.record(entry),
      logger: {
        log: (m) => this.logger.log(m),
        warn: (m) => this.logger.warn(m),
        error: (m) => this.logger.error(m),
      },
    });

    await this.engine.start();

    const cfg = await this.gate.config();
    const estado = cfg.enabled
      ? cfg.pilot
        ? `ENCENDIDO en PILOTO (solo ${cfg.allowlist.length} número(s) de la lista blanca)`
        : 'ENCENDIDO para TODOS los que escriban'
      : 'apagado';
    this.logger.log(`Agente de WhatsApp montado · ${estado} · agentes: interno, clientes, público.`);

    // Si está encendido, verificar de verdad que se puede responder. Con credenciales
    // muertas el bot pensaría en el vacío: mejor gritarlo en el arranque.
    if (cfg.enabled) {
      const probe = await this.whatsapp.probe();
      if (!probe.ok) {
        this.logger.error(`El bot está ENCENDIDO pero NO puede responder: ${probe.error}`);
      } else {
        this.logger.log(`WhatsApp listo: ${probe.name ?? '?'} (${probe.phone ?? '?'}) · calidad ${probe.quality ?? '?'}`);
        if (probe.codeVerification && probe.codeVerification !== 'VERIFIED') {
          this.logger.warn(`El número está ${probe.codeVerification} (no VERIFIED): el envío puede fallar.`);
        }
      }
    }
  }

  /** Quién atiende: lo decide la identidad ya resuelta, nunca el modelo. */
  private agentResolver(): AgentResolver {
    return {
      resolve: async (user: AgentUser) => {
        switch (identityOf(user).kind) {
          case 'interno': return AGENT_INTERNO;
          case 'cliente': return AGENT_CLIENTE;
          default: return AGENT_PUBLICO;
        }
      },
    };
  }

  /**
   * Persiste la auditoría del agente en la bitácora del ERP.
   *
   * `AuditLog.userId` es FK a User, pero el actor puede ser un abonado o un número
   * anónimo: se comprueba que el id sea de verdad un usuario antes de ligarlo, y si
   * no lo es se guarda como actor suelto en el payload. Sin esto, auditar una
   * acción de un cliente reventaría por violación de clave foránea.
   */
  private async record(entry: AuditEntry): Promise<void> {
    const isUser = await this.prisma.user
      .findUnique({ where: { id: entry.userId }, select: { id: true } })
      .catch(() => null);

    await this.auditService.record({
      userId: isUser ? entry.userId : undefined,
      action: entry.action,
      entity: 'Chatbot',
      entityId: (entry.detail?.ticketId ?? entry.detail?.subscriberId ?? entry.detail?.id) as string | undefined,
      after: { summary: entry.summary, via: entry.via, actor: entry.userId, ...entry.detail },
    });
  }

  /**
   * Estado para el panel. Incluye el diagnóstico REAL contra Kapso: sin él, "montado"
   * y "configurado" se leen como "funciona", que es justo el engaño que hay que evitar.
   */
  async status() {
    const [cfg, whatsapp, uso] = await Promise.all([
      this.gate.config(), this.whatsapp.probe(), this.usage.summary(),
    ]);
    return {
      ...cfg,
      running: !!this.engine,
      model: this.engine?.status().provider.model ?? null,
      agents: [AGENT_INTERNO, AGENT_CLIENTE, AGENT_PUBLICO],
      whatsapp,
      uso,
      /**
       * Resumen honesto: solo true si está encendido, montado, puede responder de
       * verdad Y le queda presupuesto. Cualquier "sí, pero" aquí es un bot que en la
       * práctica no contesta.
       */
      operativo: cfg.enabled && !!this.engine && whatsapp.ok && !uso.excedido,
    };
  }
}
