import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './common/audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { WhatsappModule } from './common/whatsapp/whatsapp.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { MailModule } from './common/mail/mail.module';
import { PlayhubModule } from './playhub/playhub.module';
import { MovilModule } from './movil/movil.module';
import { SubscribersModule } from './subscribers/subscribers.module';
import { BillingModule } from './billing/billing.module';
import { TreasuryModule } from './treasury/treasury.module';
import { NetworkModule } from './network/network.module';
import { SupportModule } from './support/support.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrdersModule } from './orders/orders.module';
import { CollectionsModule } from './collections/collections.module';
import { PaymentImportsModule } from './payment-imports/payment-imports.module';
import { ReturnsModule } from './returns/returns.module';
import { StaffModule } from './staff/staff.module';
import { ProjectsModule } from './projects/projects.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ReportsModule } from './reports/reports.module';
import { ConfigDataModule } from './config/config.module';
import { OmniModule } from './omni/omni.module';
import { EinvoiceModule } from './einvoice/einvoice.module';
import { CronModule } from './cron/cron.module';
import { DataModule } from './data/data.module';
import { ExtrasModule } from './extras/extras.module';
import { SettingsModule } from './settings/settings.module';
import { PublicApiModule } from './public-api/public-api.module';
import { PlansModule } from './plans/plans.module';
import { PortalModule } from './portal/portal.module';
import { PromotionsModule } from './promotions/promotions.module';
import { AccountingModule } from './accounting/accounting.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuditModule,
    AuthModule,
    WhatsappModule,
    ChatbotModule,
    MailModule,
    PlayhubModule,
    MovilModule,
    // --- Módulos Vestel (replicados de saves-vestel) ---
    SubscribersModule,
    PlansModule,
    BillingModule,
    PromotionsModule,
    TreasuryModule,
    AccountingModule,
    PortalModule,
    NetworkModule,
    SupportModule,
    InventoryModule,
    OrdersModule,
    CollectionsModule,
    PaymentImportsModule,
    ReturnsModule,
    StaffModule,
    ProjectsModule,
    DashboardModule,
    ReportsModule,
    ConfigDataModule,
    OmniModule,
    EinvoiceModule,
    CronModule,
    DataModule,
    ExtrasModule,
    SettingsModule,
    PublicApiModule,
  ],
})
export class AppModule {}
