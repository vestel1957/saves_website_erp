/**
 * Índice de rutas: qué router atiende cada prefijo. ── FICHERO GENERADO ──
 *
 * Sustituye a la lista de módulos de `app.module.ts`. Aquí no se declaran
 * dependencias —de eso se encarga el contenedor—: sólo se dice qué se publica y bajo
 * qué prefijo, que es lo único que un módulo de Nest acababa aportando.
 *
 * Varios routers comparten prefijo a propósito (`network`, `whatsapp`, `admin`):
 * Express los prueba en orden y cada uno responde a las suyas.
 *
 * Routers: 48
 */
import { accountingRouter } from '../accounting/accounting.router';
import { auditRouter } from '../common/audit/audit.router';
import { apiKeysRouter } from '../public-api/api-keys.router';
import { chatbotRouter } from '../chatbot/chatbot.router';
import { mailRouter } from '../common/mail/mail.router';
import { whatsappRouter } from '../common/whatsapp/whatsapp.router';
import { authRouter } from '../auth/auth.router';
import { billingRouter } from '../billing/billing.router';
import { clausulasRouter } from '../contracts/clausulas.router';
import { collectionsRouter } from '../collections/collections.router';
import { configRouter } from '../config/config.router';
import { cronRouter } from '../cron/cron.router';
import { dashboardRouter } from '../dashboard/dashboard.router';
import { dataRouter } from '../data/data.router';
import { einvoiceRouter } from '../einvoice/einvoice.router';
import { extrasRouter } from '../extras/extras.router';
import { geoRouter } from '../geo/geo.router';
import { inventoryRouter } from '../inventory/inventory.router';
import { manualsRouter } from '../manuals/manuals.router';
import { myPromotionsRouter } from '../promotions/mypromotions.router';
import { genieacsRouter } from '../network/genieacs.router';
import { mikrotikRouter } from '../network/mikrotik.router';
import { networkRouter } from '../network/network.router';
import { oltRouter } from '../network/olt.router';
import { notificationsRouter } from '../common/notifications/notifications.router';
import { omniRouter } from '../omni/omni.router';
import { ordersRouter } from '../orders/orders.router';
import { paymentImportsRouter } from '../payment-imports/payment-imports.router';
import { plansRouter } from '../plans/plans.router';
import { playhubRouter } from '../playhub/playhub.router';
import { portalRouter } from '../portal/portal.router';
import { profileRouter } from '../auth/profile.router';
import { signatureRouter } from '../common/signature/signature.router';
import { projectsRouter } from '../projects/projects.router';
import { promotionsRouter } from '../promotions/promotions.router';
import { publicRouter } from '../public-api/public.router';
import { reportsRouter } from '../reports/reports.router';
import { responsibilitiesRouter } from '../responsibilities/responsibilities.router';
import { returnsRouter } from '../returns/returns.router';
import { searchRouter } from '../search/search.router';
import { settingsRouter } from '../settings/settings.router';
import { staffRouter } from '../staff/staff.router';
import { subscribersRouter } from '../subscribers/subscribers.router';
import { supportRouter } from '../support/support.router';
import { tasksRouter } from '../tasks/tasks.router';
import { treasuryRouter } from '../treasury/treasury.router';
import { whatsappInboxRouter } from '../common/whatsapp/whatsapp-inbox.router';
import { whatsappWebhookRouter } from '../common/whatsapp/whatsapp-webhook.router';

export const RUTAS = [
  { prefijo: 'accounting', router: accountingRouter },
  { prefijo: 'activity', router: auditRouter },
  { prefijo: 'admin', router: apiKeysRouter },
  { prefijo: 'admin', router: chatbotRouter },
  { prefijo: 'admin', router: mailRouter },
  { prefijo: 'admin', router: whatsappRouter },
  { prefijo: 'auth', router: authRouter },
  { prefijo: 'billing', router: billingRouter },
  { prefijo: 'clausulas', router: clausulasRouter },
  { prefijo: 'collections', router: collectionsRouter },
  { prefijo: 'config', router: configRouter },
  { prefijo: 'cron', router: cronRouter },
  { prefijo: 'dashboard', router: dashboardRouter },
  { prefijo: 'data', router: dataRouter },
  { prefijo: 'einvoice', router: einvoiceRouter },
  { prefijo: 'extras', router: extrasRouter },
  { prefijo: 'geo', router: geoRouter },
  { prefijo: 'inventory', router: inventoryRouter },
  { prefijo: 'manuals', router: manualsRouter },
  { prefijo: 'my-promotions', router: myPromotionsRouter },
  { prefijo: 'network', router: genieacsRouter },
  { prefijo: 'network', router: mikrotikRouter },
  { prefijo: 'network', router: networkRouter },
  { prefijo: 'network', router: oltRouter },
  { prefijo: 'notifications', router: notificationsRouter },
  { prefijo: 'omni', router: omniRouter },
  { prefijo: 'orders', router: ordersRouter },
  { prefijo: 'payment-imports', router: paymentImportsRouter },
  { prefijo: 'plans', router: plansRouter },
  { prefijo: 'playhub', router: playhubRouter },
  { prefijo: 'portal', router: portalRouter },
  { prefijo: 'profile', router: profileRouter },
  { prefijo: 'profile', router: signatureRouter },
  { prefijo: 'projects', router: projectsRouter },
  { prefijo: 'promotions', router: promotionsRouter },
  { prefijo: 'public', router: publicRouter },
  { prefijo: 'reports', router: reportsRouter },
  { prefijo: 'responsibilities', router: responsibilitiesRouter },
  { prefijo: 'returns', router: returnsRouter },
  { prefijo: 'search', router: searchRouter },
  { prefijo: 'settings', router: settingsRouter },
  { prefijo: 'staff', router: staffRouter },
  { prefijo: 'subscribers', router: subscribersRouter },
  { prefijo: 'support', router: supportRouter },
  { prefijo: 'tasks', router: tasksRouter },
  { prefijo: 'treasury', router: treasuryRouter },
  { prefijo: 'whatsapp', router: whatsappInboxRouter },
  { prefijo: 'whatsapp', router: whatsappWebhookRouter },
];
