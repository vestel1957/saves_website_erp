import { PrismaService } from '../prisma/prisma.service';

/** Campos numéricos de la meta anual (paridad legacy `goals`). */
export const GOAL_FIELDS = [
  'income', 'expense', 'sales', 'netincome', 'users', 'vesagro', 'servicios',
  'compras', 'creditos', 'nomina', 'socios', 'oficial', 'internet',
  'programadora', 'impuestos', 'publicos', 'comisiones', 'celulares', 'purchase',
] as const;
type GoalField = (typeof GOAL_FIELDS)[number];

export const GOAL_LABELS: Record<GoalField, string> = {
  income: 'Ingresos', expense: 'Egresos', sales: 'Ventas', netincome: 'Utilidad neta',
  users: 'Abonados objetivo', vesagro: 'Vesagro', servicios: 'Servicios', compras: 'Compras',
  creditos: 'Créditos', nomina: 'Nómina', socios: 'Socios', oficial: 'Oficial',
  internet: 'Internet', programadora: 'Programadora', impuestos: 'Impuestos',
  publicos: 'Serv. públicos', comisiones: 'Comisiones', celulares: 'Celulares', purchase: 'Compras (purchase)',
};

/** Catálogo de ajustes globales. La UI se dibuja con esto aunque no exista fila. */
export interface SettingDef {
  key: string; group: string; label: string;
  secret?: boolean; multiline?: boolean; placeholder?: string; default?: string;
}
export const SETTING_DEFS: SettingDef[] = [
  { key: 'currency.code', group: 'moneda', label: 'Código de moneda (ISO)', default: 'COP', placeholder: 'COP' },
  { key: 'currency.symbol', group: 'moneda', label: 'Símbolo', default: '$', placeholder: '$' },
  { key: 'currency.decimals', group: 'moneda', label: 'Decimales', default: '0', placeholder: '0' },
  { key: 'smtp.host', group: 'smtp', label: 'Servidor SMTP', placeholder: 'smtp.dominio.com' },
  { key: 'smtp.port', group: 'smtp', label: 'Puerto', default: '587', placeholder: '587' },
  { key: 'smtp.user', group: 'smtp', label: 'Usuario', placeholder: 'no-reply@vestel.com.co' },
  { key: 'smtp.password', group: 'smtp', label: 'Contraseña', secret: true },
  { key: 'smtp.from', group: 'smtp', label: 'Remitente (From)', placeholder: 'Vestel <no-reply@vestel.com.co>' },
  { key: 'smtp.secure', group: 'smtp', label: 'Conexión segura TLS/SSL', default: 'false', placeholder: 'true | false' },
  { key: 'billing.dueDay', group: 'billing', label: 'Día de vencimiento de facturas (1-28)', default: '20', placeholder: '20' },
  { key: 'network.mikrotikLive', group: 'red', label: 'Ejecutar cortes/reconexiones REALES en Mikrotik', default: 'false', placeholder: 'true | false' },
  { key: 'network.oltLive', group: 'red', label: 'Ejecutar aprovisionamiento REAL en OLT', default: 'false', placeholder: 'true | false' },
  { key: 'network.oltAutoProvision', group: 'red', label: 'Auto-autenticar ONUs de la cola cuando aparezcan (requiere OLT en modo real)', default: 'false', placeholder: 'true | false' },
  { key: 'network.genieacsLive', group: 'red', label: 'Ejecutar cortes REALES de TV en GenieACS (TR-069)', default: 'false', placeholder: 'true | false' },
  { key: 'tickets.cascadeBilling', group: 'soporte', label: 'Al cerrar orden: generar cargos automáticos (reconexión/instalación)', default: 'false', placeholder: 'true | false' },
  // Chatbot de WhatsApp. Se editan desde Configuración → WhatsApp (endpoints
  // /admin/chatbot/switch y /allowlist), pero se declaran aquí para que existan en el
  // catálogo y no queden como claves sueltas invisibles en AppSetting.
  { key: 'chatbot.enabled', group: 'chatbot', label: 'Responder automáticamente en WhatsApp con el agente de IA', default: 'false', placeholder: 'true | false' },
  { key: 'chatbot.allowlist', group: 'chatbot', label: 'Piloto: solo responder a estos teléfonos (vacío = todos)', placeholder: '573001112233, 573004445566' },
  { key: 'purchases.dualApprovalThreshold', group: 'compras', label: 'Compras: monto desde el cual una orden exige DOS aprobaciones (0 = nunca)', default: '2000000', placeholder: '2000000' },
  { key: 'billing.invoiceTerms', group: 'billing', label: 'Términos de la factura', multiline: true },
  { key: 'billing.contractClause', group: 'billing', label: 'Cláusula de contrato', multiline: true },
  { key: 'billing.docFooter', group: 'billing', label: 'Pie de página de documentos', multiline: true },
];
const DEF_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

const MASK = '••••••••';

export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- Metas / goals ----------
  async goals() {
    const row = (await this.prisma.businessGoal.findFirst({ orderBy: { legacyId: 'asc' } }))
      ?? (await this.prisma.businessGoal.create({ data: { legacyId: 1 } }));
    const values: Record<string, number> = {};
    for (const f of GOAL_FIELDS) values[f] = Number(row[f] ?? 0n);
    return {
      id: row.id,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      fields: GOAL_FIELDS.map((f) => ({ key: f, label: GOAL_LABELS[f], value: values[f] })),
      values,
    };
  }

  async updateGoals(input: Record<string, unknown>, updatedBy?: string) {
    const row = (await this.prisma.businessGoal.findFirst({ orderBy: { legacyId: 'asc' } }))
      ?? (await this.prisma.businessGoal.create({ data: { legacyId: 1 } }));
    const data: Record<string, bigint> = {};
    for (const f of GOAL_FIELDS) {
      if (input[f] === undefined || input[f] === null || input[f] === '') continue;
      const n = Math.max(0, Math.round(Number(input[f])));
      if (!Number.isFinite(n)) continue;
      data[f] = BigInt(n);
    }
    await this.prisma.businessGoal.update({ where: { id: row.id }, data: { ...data, updatedBy } });
    return this.goals();
  }

  // ---------- Ajustes key/value ----------
  async settings() {
    const stored = await this.prisma.appSetting.findMany();
    const byKey = new Map(stored.map((s) => [s.key, s]));
    const items = SETTING_DEFS.map((def) => {
      const row = byKey.get(def.key);
      const secret = !!def.secret;
      const hasValue = !!(row?.value && row.value.length > 0);
      return {
        key: def.key, group: def.group, label: def.label,
        secret, multiline: !!def.multiline, placeholder: def.placeholder ?? '',
        // Los secretos NUNCA se devuelven en claro; solo si tienen valor.
        value: secret ? (hasValue ? MASK : '') : (row?.value ?? def.default ?? ''),
        hasValue,
        updatedAt: row?.updatedAt ?? null,
      };
    });
    const groups = ['moneda', 'smtp', 'billing'];
    return {
      groups: groups.map((g) => ({
        group: g,
        title: g === 'moneda' ? 'Moneda' : g === 'smtp' ? 'Correo saliente (SMTP)' : 'Términos y textos de facturación',
        items: items.filter((i) => i.group === g),
      })),
    };
  }

  async updateSettings(values: Record<string, string>, updatedBy?: string) {
    for (const [key, raw] of Object.entries(values ?? {})) {
      const def = DEF_BY_KEY.get(key);
      if (!def) continue; // solo claves conocidas del catálogo
      // Un secreto enviado como la máscara = "no cambiar".
      if (def.secret && raw === MASK) continue;
      const value = raw ?? '';
      await this.prisma.appSetting.upsert({
        where: { key },
        create: { key, value, group: def.group, secret: !!def.secret, updatedBy },
        update: { value, updatedBy },
      });
    }
    return this.settings();
  }

  /** Lectura interna (con secretos en claro) para futuros consumidores (mailer, PDFs). */
  async raw(prefix?: string): Promise<Record<string, string>> {
    const rows = await this.prisma.appSetting.findMany(
      prefix ? { where: { key: { startsWith: prefix } } } : undefined,
    );
    const out: Record<string, string> = {};
    for (const r of rows) if (r.value != null) out[r.key] = r.value;
    return out;
  }
}
