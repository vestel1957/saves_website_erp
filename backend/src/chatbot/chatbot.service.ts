import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AgentEngine, type AgentResolver, type AgentUser, type AuditEntry } from '@s4gk/wa-agent';
import { OpenAiProvider } from '@s4gk/wa-agent/openai';
import { WhisperTranscriber } from '@s4gk/wa-agent/whisper';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
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

  get enabled(): boolean {
    return process.env.WA_AGENT_ENABLED === 'true';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Agente de WhatsApp DESACTIVADO (WA_AGENT_ENABLED != true).');
      return;
    }
    if (!process.env.OPENAI_API_KEY) {
      this.logger.warn('OPENAI_API_KEY no configurada: el agente NO se inicia.');
      return;
    }

    const internoToolset = combineToolsets(
      this.abonados, this.tickets, this.red, this.inventario, this.caja, this.reportes,
    );

    this.engine = new AgentEngine({
      provider: new OpenAiProvider({ model: process.env.WHATSAPP_BOT_MODEL ?? 'gpt-4o-mini' }),
      transports: [this.transport],
      identity: this.identity,
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
    const modo = this.transport.ready ? 'Kapso conectado' : 'Kapso SIN configurar (no podrá responder)';
    this.logger.log(`Agente de WhatsApp activo (${modo}) · agentes: interno, clientes, público.`);
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

  /** Estado para diagnóstico (lo consume el endpoint de administración). */
  status() {
    return {
      enabled: this.enabled,
      running: !!this.engine,
      transportReady: this.transport.ready,
      agents: [AGENT_INTERNO, AGENT_CLIENTE, AGENT_PUBLICO],
      ...(this.engine?.status() ?? {}),
    };
  }
}
