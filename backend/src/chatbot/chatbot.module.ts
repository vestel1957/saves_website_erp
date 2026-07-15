import { Module } from '@nestjs/common';
import { WhatsappModule } from '../common/whatsapp/whatsapp.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { BillingModule } from '../billing/billing.module';
import { SupportModule } from '../support/support.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NetworkModule } from '../network/network.module';
import { ReportsModule } from '../reports/reports.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { PlansModule } from '../plans/plans.module';
import { ConfigDataModule } from '../config/config.module';
import { ChatbotService } from './chatbot.service';
import { ChatbotIdentityService } from './chatbot-identity.service';
import { ChatbotLinkService } from './chatbot-link.service';
import { ChatbotController } from './chatbot.controller';
import { SavesTransport } from './saves-transport';
import { InternoAbonadosToolset } from './toolsets/interno-abonados.toolset';
import { InternoTicketsToolset } from './toolsets/interno-tickets.toolset';
import { InternoRedToolset } from './toolsets/interno-red.toolset';
import { InternoInventarioToolset } from './toolsets/interno-inventario.toolset';
import { InternoCajaToolset } from './toolsets/interno-caja.toolset';
import { InternoReportesToolset } from './toolsets/interno-reportes.toolset';
import { ClienteToolset } from './toolsets/cliente.toolset';
import { PublicoToolset } from './toolsets/publico.toolset';

/**
 * Agente de WhatsApp con IA (multi-agente: interno / clientes / público).
 *
 * Este módulo es el CONSUMIDOR de todo: importa las áreas del ERP para que sus
 * toolsets llamen a los mismos servicios que la web. Nadie lo importa a él —y
 * nadie debe hacerlo— porque importa WhatsappModule, y BillingModule también:
 * que el chatbot fuera dependencia de un módulo de dominio cerraría un ciclo.
 * El acople de entrada es por evento (ver SavesTransport), justamente para eso.
 */
@Module({
  imports: [
    WhatsappModule,
    SubscribersModule,
    TreasuryModule,
    BillingModule,
    SupportModule,
    InventoryModule,
    NetworkModule,
    ReportsModule,
    DashboardModule,
    PlansModule,
    ConfigDataModule,
  ],
  controllers: [ChatbotController],
  providers: [
    ChatbotService,
    ChatbotIdentityService,
    ChatbotLinkService,
    SavesTransport,
    InternoAbonadosToolset,
    InternoTicketsToolset,
    InternoRedToolset,
    InternoInventarioToolset,
    InternoCajaToolset,
    InternoReportesToolset,
    ClienteToolset,
    PublicoToolset,
  ],
})
export class ChatbotModule {}
