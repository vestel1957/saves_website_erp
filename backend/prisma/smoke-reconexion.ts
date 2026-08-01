/* Smoke read-only: corre la DECISIÓN de reconexión contra la BD real.
   Los equipos van dobles y devuelven dryRun=true → no se escribe nada. */
import { PrismaClient } from '@prisma/client';
import { ReconexionService } from '../src/network/reconexion.service';

const prisma = new PrismaClient();
const falso = (nombre: string) => new Proxy({}, { get: () => async (...a: any[]) => {
  const ids: string[] = Array.isArray(a[0]) ? a[0] : [a[0]];
  console.log(`   → ${nombre}: ${JSON.stringify(ids)}`);
  return { ok: true, dryRun: true, total: ids.length, message: 'simulado',
    results: ids.map((id) => ({ subscriberId: id, ok: true, dryRun: true, via: 'TR069', detail: 'simulado' })) };
} }) as any;

(async () => {
  const srv = new ReconexionService(prisma as any, falso('mikrotik'), falso('genieacs'));
  const casos = await prisma.$queryRawUnsafe<any[]>(`
    select s.id, s.abonado, s.status,
           (s."pppUsername" is not null) as ppp,
           exists (select 1 from "SubscriberService" v where v."subscriberId"=s.id and v.kind in ('TV','PUNTOS')) as tv
    from "Subscriber" s
    where s.status in ('CORTADO','CARTERA','COMPROMISO','SUSPENDIDO','RETIRADO','ACTIVO')
    order by s.status, s.abonado`).then((r) => {
      // Un caso por combinación estado × pppoe × tv (la BD trae miles de ACTIVOs).
      const m = new Map<string, any>();
      for (const c of r) { const k = `${c.status}/${c.ppp}/${c.tv}`; if (!m.has(k)) m.set(k, c); }
      return [...m.values()];
    });
  const vistos = new Set<string>();
  for (const c of casos) {
    const clave = `${c.status}/${c.ppp}/${c.tv}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    console.log(`\n[${c.status}] abonado ${c.abonado} · pppoe=${c.ppp} tv=${c.tv}`);
    const r = await srv.porPago(c.id);
    console.log(`   aplica=${r.aplica} ok=${r.ok} · ${r.servicios.map((s: any) => s.servicio).join('+') || '—'} · ${r.mensaje}`);
  }
  await prisma.$disconnect();
})();
