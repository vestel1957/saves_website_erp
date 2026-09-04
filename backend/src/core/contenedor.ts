/**
 * Cableado de servicios (composition root). ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-contenedor.ts` a partir de los constructores reales.
 * No se edita a mano: vuelve a generarse cuando cambian las dependencias.
 *
 * Sustituye al contenedor de inyección de Nest. Aquí no hay reflexión ni
 * descubrimiento: cada servicio se construye una vez, en orden topológico, y se
 * exporta como una constante. Quién depende de quién se lee en la propia llamada.
 *
 * Servicios: 114
 */
import { eventos } from './eventos';
import { AccountsService } from '../accounting/accounts.service';
import { CostCentersService } from '../accounting/cost-centers.service';
import { JournalService } from '../accounting/journal.service';
import { MappingsService } from '../accounting/mappings.service';
import { PeriodsService } from '../accounting/periods.service';
import { PostingService } from '../accounting/posting.service';
import { ReportsService } from '../accounting/reports.service';
import { AuthService } from '../auth/auth.service';
import { ProfileService } from '../auth/profile.service';
import { BillingService } from '../billing/billing.service';
import { CatalogoService } from '../billing/catalogo.service';
import { FacturasService } from '../billing/facturas.service';
import { ProrrateoReconexionService } from '../billing/prorrateo-reconexion.service';
import { CargoOrdenService } from '../billing/cargo-orden.service';
import { RecurringService } from '../billing/recurring.service';
import { AvisosProactivosService } from '../chatbot/avisos-proactivos.service';
import { ChatAccessService } from '../chatbot/chat-access.service';
import { ChatbotActividadService } from '../chatbot/chatbot-actividad.service';
import { ChatbotDocsService } from '../chatbot/chatbot-docs.service';
import { ChatbotGateService } from '../chatbot/chatbot-gate.service';
import { ChatbotIdentityService } from '../chatbot/chatbot-identity.service';
import { ChatbotLinkService } from '../chatbot/chatbot-link.service';
import { ChatbotSessionStore } from '../chatbot/chatbot-session.store';
import { ChatbotUsageService } from '../chatbot/chatbot-usage.service';
import { ChatbotService } from '../chatbot/chatbot.service';
import { SavesTransport } from '../chatbot/saves-transport';
import { SubscriberContactsService } from '../chatbot/subscriber-contacts.service';
import { TicketConfirmacionService } from '../chatbot/ticket-confirmacion.service';
import { ClienteToolset } from '../chatbot/toolsets/cliente.toolset';
import { ComercialToolset } from '../chatbot/toolsets/comercial.toolset';
import { InternoAbonadosToolset } from '../chatbot/toolsets/interno-abonados.toolset';
import { InternoCajaToolset } from '../chatbot/toolsets/interno-caja.toolset';
import { InternoCobranzaToolset } from '../chatbot/toolsets/interno-cobranza.toolset';
import { InternoComprasToolset } from '../chatbot/toolsets/interno-compras.toolset';
import { InternoDatosToolset } from '../chatbot/toolsets/interno-datos.toolset';
import { InternoFacturacionToolset } from '../chatbot/toolsets/interno-facturacion.toolset';
import { InternoInventarioToolset } from '../chatbot/toolsets/interno-inventario.toolset';
import { InternoOperacionToolset } from '../chatbot/toolsets/interno-operacion.toolset';
import { InternoRedToolset } from '../chatbot/toolsets/interno-red.toolset';
import { InternoReportesToolset } from '../chatbot/toolsets/interno-reportes.toolset';
import { InternoRrhhToolset } from '../chatbot/toolsets/interno-rrhh.toolset';
import { InternoTicketsToolset } from '../chatbot/toolsets/interno-tickets.toolset';
import { PublicoToolset } from '../chatbot/toolsets/publico.toolset';
import { TramitesToolset } from '../chatbot/toolsets/tramites.toolset';
import { CollectionsService } from '../collections/collections.service';
import { AuditService } from '../common/audit/audit.service';
import { MailService } from '../common/mail/mail.service';
import { NotificationsService } from '../common/notifications/notifications.service';
import { AvisoTecnicoService } from '../support/aviso-tecnico.service';
import { PasswordOtpService } from '../common/signature/password-otp.service';
import { SignatureOtpService } from '../common/signature/signature-otp.service';
import { WhatsappCampaignService } from '../common/whatsapp/whatsapp-campaign.service';
import { WhatsappInboxService } from '../common/whatsapp/whatsapp-inbox.service';
import { WhatsappInternalAlertListener } from '../common/whatsapp/whatsapp-internal-alert.listener';
import { WhatsappLogService } from '../common/whatsapp/whatsapp-log.service';
import { WhatsappRemindersService } from '../common/whatsapp/whatsapp-reminders.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { ConfigDataService } from '../config/config.service';
import { ContractsService } from '../contracts/contracts.service';
import { CronService } from '../cron/cron.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { DataService } from '../data/data.service';
import { EinvoiceEmitService } from '../einvoice/einvoice-emit.service';
import { EinvoiceService } from '../einvoice/einvoice.service';
import { ExtrasService } from '../extras/extras.service';
import { GeoService } from '../geo/geo.service';
import { RoutingService } from '../geo/routing.service';
import { InventoryAlertsService } from '../inventory/alerts.service';
import { InventoryService } from '../inventory/inventory.service';
import { ManualsService } from '../manuals/manuals.service';
import { GenieacsService } from '../network/genieacs.service';
import { MikrotikAdminService } from '../network/mikrotik-admin.service';
import { IpAllocatorService } from '../network/ip-allocator.service';
import { MikrotikService } from '../network/mikrotik.service';
import { NetworkWriteService } from '../network/network-write.service';
import { NetworkService } from '../network/network.service';
import { OltPlanProfileService } from '../network/olt-plan-profile.service';
import { OltService } from '../network/olt.service';
import { ReconexionService } from '../network/reconexion.service';
import { OmniService } from '../omni/omni.service';
import { OrdersService } from '../orders/orders.service';
import { OnlinePaymentsService } from '../online-payments/online-payments.service';
import { PaymentImportsService } from '../payment-imports/payment-imports.service';
import { PlansService } from '../plans/plans.service';
import { BundlesService } from '../plans/bundles.service';
import { PlayhubClient } from '../playhub/playhub.client';
import { PlayhubService } from '../playhub/playhub.service';
import { PortalService } from '../portal/portal.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { PromotionsService } from '../promotions/promotions.service';
import { ApiKeysService } from '../public-api/api-keys.service';
import { PublicService } from '../public-api/public.service';
import { IspReportsService } from '../reports/isp-reports.service';
import { MetricsService } from '../reports/metrics.service';
import { PerformanceService } from '../reports/performance.service';
import { ReportsService as ReportsReportsService } from '../reports/reports.service';
import { StaffReportsService } from '../reports/staff-reports.service';
import { ResponsibilitiesService } from '../responsibilities/responsibilities.service';
import { ResponsibilityNotifierService } from '../responsibilities/responsibility-notifier.service';
import { ReturnsService } from '../returns/returns.service';
import { DataQueryService } from '../search/data-query.service';
import { SearchService } from '../search/search.service';
import { SettingsService } from '../settings/settings.service';
import { StaffDocumentsService } from '../staff/staff-documents.service';
import { StaffService } from '../staff/staff.service';
import { AltaClienteService } from '../subscribers/alta.service';
import { SubscriberFilesService } from '../subscribers/subscriber-files.service';
import { SubscriberGeoService } from '../subscribers/subscriber-geo.service';
import { SubscriberNotesService } from '../subscribers/subscriber-notes.service';
import { SubscribersService } from '../subscribers/subscribers.service';
import { AgendaService } from '../support/agenda.service';
import { GeofenceService } from '../support/geofence.service';
import { OnuProvisionService } from '../support/onu-provision.service';
import { EquipoReservaService } from '../support/equipo-reserva.service';
import { OrderScoreService } from '../support/order-score.service';
import { SupportWriteService } from '../support/support-write.service';
import { OrdenesAutomaticasService } from '../support/ordenes-automaticas.service';
import { SupportService } from '../support/support.service';
import { TasksService } from '../tasks/tasks.service';
import { CobranzasService } from '../treasury/cobranzas.service';
import { PagosFijosService } from '../treasury/pagos-fijos.service';
import { TreasuryService } from '../treasury/treasury.service';

export const prismaService = new PrismaService();
export const accountsService = new AccountsService(prismaService);
export const costCentersService = new CostCentersService(prismaService);
export const periodsService = new PeriodsService(prismaService);
export const journalService = new JournalService(prismaService, periodsService);
export const mappingsService = new MappingsService(prismaService);
export const postingService = new PostingService(journalService, mappingsService, prismaService);
export const accountingReportsService = new ReportsService(prismaService);
export const whatsappService = new WhatsappService(eventos);
export const signatureOtpService = new SignatureOtpService(prismaService, whatsappService);
export const passwordOtpService = new PasswordOtpService(signatureOtpService);
export const authService = new AuthService(prismaService, passwordOtpService);
export const auditService = new AuditService(prismaService);
export const profileService = new ProfileService(prismaService, auditService, passwordOtpService);
export const settingsService = new SettingsService(prismaService);
export const mailService = new MailService(prismaService, settingsService);
export const billingService = new BillingService(prismaService, whatsappService, mailService);
export const catalogoService = new CatalogoService(prismaService);
export const ipAllocatorService = new IpAllocatorService(prismaService);
export const mikrotikService = new MikrotikService(prismaService, whatsappService, ipAllocatorService);
export const oltService = new OltService(prismaService);
export const genieacsService = new GenieacsService(prismaService, oltService);
// Avisos por cargo. Se construye ANTES que la reconexión porque las órdenes que
// abre el sistema (`OrdenesAutomaticasService`) tienen que avisarle a quien reparte
// el trabajo de campo.
export const notificationsService = new NotificationsService(prismaService);
export const avisoTecnicoService = new AvisoTecnicoService(prismaService, notificationsService);
export const responsibilitiesService = new ResponsibilitiesService(prismaService);
export const responsibilityNotifierService = new ResponsibilityNotifierService(responsibilitiesService, notificationsService, eventos);
// Órdenes de servicio que abre el sistema cuando algo no se pudo hacer por red.
export const ordenesAutomaticasService = new OrdenesAutomaticasService(prismaService, responsibilityNotifierService);
// Cobro de los días que quedan del mes al devolver un servicio cortado (las órdenes
// "…2" del legacy). Se construye ANTES de la reconexión y del soporte porque las dos
// puertas por las que vuelve un servicio —el pago en caja y el técnico que cierra la
// orden— cobran por aquí.
export const prorrateoReconexionService = new ProrrateoReconexionService(prismaService, postingService);
// Los cobros que salen solos al abrir una orden (traslado, agregar internet):
// ver `billing/cargos-orden.ts` para la lista de tipos que llevan cargo.
export const cargoOrdenService = new CargoOrdenService(prismaService, postingService);
export const reconexionService = new ReconexionService(prismaService, mikrotikService, genieacsService, ordenesAutomaticasService, prorrateoReconexionService, eventos);
// Puente con el portal de pagos en línea. Sube AQUÍ, fuera del orden alfabético,
// porque `cronService` —que lo dispara cada 5 min— se construye antes de la P y
// una `const` todavía en zona muerta temporal revienta al arrancar.
export const onlinePaymentsService = new OnlinePaymentsService(prismaService, reconexionService);
export const cobranzasService = new CobranzasService(prismaService, postingService, reconexionService, eventos);
// Sube AQUÍ, fuera del orden alfabético: `facturasService` lo necesita para "asignar
// servicio" —el cambio de plan desde la factura pasa por el mismo camino que desde la
// ficha del abonado— y una `const` todavía en zona muerta temporal revienta al arrancar.
export const mikrotikAdminService = new MikrotikAdminService(prismaService);
export const subscribersService = new SubscribersService(prismaService, mikrotikService, mikrotikAdminService, genieacsService, eventos);
export const facturasService = new FacturasService(prismaService, postingService, cobranzasService, subscribersService);
export const recurringService = new RecurringService(prismaService, facturasService);
export const whatsappInboxService = new WhatsappInboxService(prismaService, whatsappService, notificationsService, responsibilityNotifierService);
export const chatbotSessionStore = new ChatbotSessionStore(prismaService, whatsappInboxService);
export const chatbotUsageService = new ChatbotUsageService(prismaService);
export const chatbotGateService = new ChatbotGateService(prismaService, chatbotSessionStore, chatbotUsageService);
export const avisosProactivosService = new AvisosProactivosService(prismaService, whatsappService, chatbotGateService);
export const chatAccessService = new ChatAccessService(prismaService, whatsappService);
export const chatbotActividadService = new ChatbotActividadService(prismaService);
export const contractsService = new ContractsService(prismaService);
export const orderScoreService = new OrderScoreService(prismaService);
export const supportService = new SupportService(prismaService, orderScoreService);
export const treasuryService = new TreasuryService(prismaService);
export const ordersService = new OrdersService(prismaService, responsibilityNotifierService, signatureOtpService);
export const reportsService = new ReportsReportsService(prismaService);
export const performanceService = new PerformanceService(prismaService);
export const staffReportsService = new StaffReportsService(prismaService);
export const ispReportsService = new IspReportsService(prismaService);
export const metricsService = new MetricsService(prismaService);
export const dashboardService = new DashboardService(prismaService);
export const chatbotDocsService = new ChatbotDocsService(subscribersService, contractsService, billingService, supportService, treasuryService, ordersService, reportsService, performanceService, staffReportsService, ispReportsService, metricsService, dashboardService);
export const chatbotIdentityService = new ChatbotIdentityService(prismaService, authService, chatAccessService);
export const chatbotLinkService = new ChatbotLinkService(prismaService);
export const geofenceService = new GeofenceService(prismaService);
// `routingService` sube aquí porque `agendaService` lo usa para la matriz de
// distancias del recorrido sugerido, y el orden de este fichero es topológico.
export const routingService = new RoutingService();
export const agendaService = new AgendaService(prismaService, eventos, routingService);
export const supportWriteService = new SupportWriteService(prismaService, mikrotikService, geofenceService, responsibilityNotifierService, eventos, agendaService, orderScoreService, prorrateoReconexionService, genieacsService, cargoOrdenService, subscribersService);
export const altaClienteService = new AltaClienteService(prismaService, subscribersService, mikrotikService, facturasService, supportWriteService);
export const ticketConfirmacionService = new TicketConfirmacionService(prismaService, whatsappService, supportWriteService, chatbotGateService);
export const savesTransport = new SavesTransport(whatsappService, chatbotGateService, ticketConfirmacionService);
export const internoAbonadosToolset = new InternoAbonadosToolset(subscribersService, cobranzasService, chatbotDocsService);
export const internoTicketsToolset = new InternoTicketsToolset(supportService, supportWriteService, chatbotDocsService);
export const internoRedToolset = new InternoRedToolset(mikrotikService, subscribersService, oltService, prismaService);
export const inventoryService = new InventoryService(prismaService, signatureOtpService, whatsappService, notificationsService);
export const internoInventarioToolset = new InternoInventarioToolset(inventoryService, supportService, supportWriteService);
export const internoCajaToolset = new InternoCajaToolset(treasuryService, cobranzasService, chatbotDocsService);
export const internoReportesToolset = new InternoReportesToolset(reportsService, dashboardService, performanceService, staffReportsService, ispReportsService, metricsService, billingService, chatbotDocsService, prismaService);
export const subscriberContactsService = new SubscriberContactsService(prismaService, whatsappService);
export const clienteToolset = new ClienteToolset(subscribersService, cobranzasService, chatbotSessionStore, mikrotikService, subscriberContactsService, chatAccessService, chatbotDocsService);
export const publicoToolset = new PublicoToolset(subscriberContactsService, chatAccessService, chatbotSessionStore);
export const plansService = new PlansService(prismaService);
export const bundlesService = new BundlesService(prismaService);
export const configDataService = new ConfigDataService(prismaService);
export const comercialToolset = new ComercialToolset(plansService, configDataService, chatbotGateService);
export const tramitesToolset = new TramitesToolset(subscribersService, cobranzasService, supportWriteService, genieacsService);
export const staffService = new StaffService(prismaService, authService, auditService);
export const internoRrhhToolset = new InternoRrhhToolset(staffService);
export const internoComprasToolset = new InternoComprasToolset(ordersService, chatbotDocsService);
export const einvoiceService = new EinvoiceService(prismaService);
export const internoFacturacionToolset = new InternoFacturacionToolset(billingService, facturasService, recurringService, einvoiceService, chatbotDocsService);
export const collectionsService = new CollectionsService(prismaService, responsibilityNotifierService);
export const internoCobranzaToolset = new InternoCobranzaToolset(collectionsService, cobranzasService);
export const promotionsService = new PromotionsService(prismaService, facturasService);
export const returnsService = new ReturnsService(prismaService);
export const projectsService = new ProjectsService(prismaService);
export const geoService = new GeoService(prismaService, routingService);
export const internoOperacionToolset = new InternoOperacionToolset(plansService, promotionsService, returnsService, projectsService, geoService);
export const dataQueryService = new DataQueryService(prismaService);
export const internoDatosToolset = new InternoDatosToolset(dataQueryService);
export const chatbotService = new ChatbotService(prismaService, auditService, whatsappService, chatbotGateService, chatbotSessionStore, chatbotUsageService, savesTransport, chatbotIdentityService, internoAbonadosToolset, internoTicketsToolset, internoRedToolset, internoInventarioToolset, internoCajaToolset, internoReportesToolset, clienteToolset, publicoToolset, comercialToolset, tramitesToolset, internoRrhhToolset, internoComprasToolset, internoFacturacionToolset, internoCobranzaToolset, internoOperacionToolset, internoDatosToolset);
export const whatsappCampaignService = new WhatsappCampaignService(prismaService, whatsappService);
export const whatsappInternalAlertListener = new WhatsappInternalAlertListener(whatsappService);
export const whatsappLogService = new WhatsappLogService(prismaService, whatsappInboxService);
export const whatsappRemindersService = new WhatsappRemindersService(prismaService, whatsappCampaignService);
export const cronService = new CronService(prismaService, facturasService, mailService, whatsappRemindersService, metricsService, responsibilityNotifierService, altaClienteService, onlinePaymentsService);
export const dataService = new DataService(prismaService);
export const einvoiceEmitService = new EinvoiceEmitService(prismaService);
export const extrasService = new ExtrasService(prismaService);
export const inventoryAlertsService = new InventoryAlertsService(prismaService);
export const manualsService = new ManualsService();
export const networkWriteService = new NetworkWriteService(prismaService, signatureOtpService, whatsappService, notificationsService);
export const networkService = new NetworkService(prismaService);
export const oltPlanProfileService = new OltPlanProfileService(prismaService, oltService);
export const omniService = new OmniService(prismaService, postingService);
export const paymentImportsService = new PaymentImportsService(prismaService, cobranzasService, reconexionService);
export const playhubClient = new PlayhubClient();
export const playhubService = new PlayhubService(prismaService, playhubClient);
export const portalService = new PortalService(prismaService);
export const apiKeysService = new ApiKeysService(prismaService);
export const publicService = new PublicService(prismaService);
export const searchService = new SearchService(subscribersService, billingService);
export const staffDocumentsService = new StaffDocumentsService(prismaService);
export const subscriberFilesService = new SubscriberFilesService(prismaService);
export const subscriberGeoService = new SubscriberGeoService(prismaService);
export const subscriberNotesService = new SubscriberNotesService(prismaService);
export const equipoReservaService = new EquipoReservaService(prismaService);
export const onuProvisionService = new OnuProvisionService(prismaService, oltService, oltPlanProfileService, equipoReservaService);
export const tasksService = new TasksService(prismaService);
export const pagosFijosService = new PagosFijosService(prismaService, cobranzasService);

/** Todos los servicios, para los ganchos de arranque y apagado. */
export const todosLosServicios = [
  prismaService,
  accountsService,
  costCentersService,
  periodsService,
  journalService,
  mappingsService,
  cargoOrdenService,
  postingService,
  accountingReportsService,
  whatsappService,
  signatureOtpService,
  passwordOtpService,
  authService,
  auditService,
  profileService,
  settingsService,
  mailService,
  billingService,
  catalogoService,
  ipAllocatorService,
  mikrotikService,
  oltService,
  genieacsService,
  reconexionService,
  cobranzasService,
  facturasService,
  recurringService,
  notificationsService,
  responsibilitiesService,
  responsibilityNotifierService,
  whatsappInboxService,
  chatbotSessionStore,
  chatbotUsageService,
  chatbotGateService,
  avisosProactivosService,
  chatAccessService,
  chatbotActividadService,
  mikrotikAdminService,
  subscribersService,
  contractsService,
  orderScoreService,
  supportService,
  treasuryService,
  ordersService,
  reportsService,
  performanceService,
  staffReportsService,
  ispReportsService,
  metricsService,
  dashboardService,
  chatbotDocsService,
  chatbotIdentityService,
  chatbotLinkService,
  geofenceService,
  agendaService,
  supportWriteService,
  ordenesAutomaticasService,
  altaClienteService,
  ticketConfirmacionService,
  savesTransport,
  internoAbonadosToolset,
  internoTicketsToolset,
  internoRedToolset,
  inventoryService,
  internoInventarioToolset,
  internoCajaToolset,
  internoReportesToolset,
  subscriberContactsService,
  clienteToolset,
  publicoToolset,
  plansService,
  configDataService,
  comercialToolset,
  tramitesToolset,
  staffService,
  internoRrhhToolset,
  internoComprasToolset,
  einvoiceService,
  internoFacturacionToolset,
  collectionsService,
  internoCobranzaToolset,
  promotionsService,
  returnsService,
  projectsService,
  routingService,
  geoService,
  internoOperacionToolset,
  dataQueryService,
  internoDatosToolset,
  chatbotService,
  whatsappCampaignService,
  whatsappInternalAlertListener,
  whatsappLogService,
  whatsappRemindersService,
  cronService,
  dataService,
  einvoiceEmitService,
  extrasService,
  inventoryAlertsService,
  manualsService,
  networkWriteService,
  networkService,
  oltPlanProfileService,
  omniService,
  onlinePaymentsService,
  paymentImportsService,
  playhubClient,
  playhubService,
  portalService,
  apiKeysService,
  publicService,
  searchService,
  staffDocumentsService,
  subscriberFilesService,
  subscriberGeoService,
  subscriberNotesService,
  onuProvisionService,
  tasksService,
  pagosFijosService,
];
