/**
 * Barrido ficha → `/ppp/secret`: pone los Mikrotik de acuerdo con lo que dicen las
 * fichas de los abonados (comentario con la VLAN, IP local y la IP remota que falte)
 * y DA DE ALTA a los que no tienen secret.
 *
 * Lo mismo que corre solo cada madrugada (tarea `secrets-al-dia`), a mano y con
 * informe. Por defecto NO toca nada: enseña qué cambiaría y a quién daría de alta.
 *
 *   npm run secrets:conciliar               → informe
 *   npm run secrets:conciliar -- --aplicar  → lo escribe de verdad
 *   npm run secrets:conciliar -- --router=<id> --limite=200
 *   npm run secrets:conciliar -- --aplicar --sin-crear  → sólo conciliar, sin altas
 *
 * Exige MIKROTIK_LIVE=true (o el interruptor de Configuración): en dry-run no abre
 * socket contra ningún router.
 */
import { PrismaClient } from '@prisma/client';
import { MikrotikService } from '../src/network/mikrotik.service';
import { IpAllocatorService } from '../src/network/ip-allocator.service';

const args = process.argv.slice(2);
const flag = (nombre: string) => args.find((a) => a.startsWith(`--${nombre}=`))?.split('=')[1];

async function main() {
  const prisma = new PrismaClient();
  const aplicar = args.includes('--aplicar');
  // WhatsApp no lo usa; el repartidor de IPs SÍ, desde que el barrido da de alta a
  // quien no tiene secret (a un abonado nuevo hay que ponerle una IP libre).
  const mikrotik = new MikrotikService(prisma as any, {} as any, new IpAllocatorService(prisma as any));

  const r = await mikrotik.conciliarSecretsEnLote({
    aplicar,
    crearFaltantes: !args.includes('--sin-crear'),
    mikrotikId: flag('router'),
    branchId: flag('sede'),
    limite: flag('limite') ? Number(flag('limite')) : undefined,
  });

  console.log(`\n${r.message}\n`);
  console.table(r.routers);
  console.log({
    abonados: r.total,
    alDia: r.alDia,
    corregidos: r.corregidos,
    comentarios: r.comentario,
    ipLocalRellenada: r.ipLocal,
    ipRemotaRellenada: r.ipRemota,
    sinSecretEnElRouter: r.sinSecret,
    sinRouter: r.sinRouter,
    // Lo que el barrido deja como está a propósito:
    fichaSinComentario: r.comentarioVacio,
    direccionesQueYaTenia: r.ipOmitida + r.ipLocalOmitida,
    perfilesDistintos: r.perfilDistinto,
    clavesDistintas: r.claveDistinta,
  });
  console.log('\nDe los que NO tienen secret en el router:');
  console.log({
    sinSecret: r.sinSecret,
    dadosDeAlta: r.creados,
    listosParaDarDeAlta: r.porCrear,
    // No son abonados sin servicio: son clientes de TV. El `name_s` del legacy
    // trae '0' o '-' cuando no hay internet, y así inflaban el "sin secret".
    sinInternet_usuarioDeRelleno: r.sinUsuarioReal,
    // Lo que hay que corregir a mano en la ficha para poder darlos de alta:
    perfilSinResolver: r.perfilSinResolver,
    // Su mismo nombre mal escrito ya está en el router: crear el segundo dejaría
    // dos secrets peleándose la IP. Es trabajo de ficha, no de red.
    mismoAbonadoConNombreMalEscrito: r.posibleDuplicado,
    // La IP de la ficha era de otro: se creó igual, con una libre.
    ipDeFichaOcupada_seRepartioOtra: r.ipDeFichaOcupada,
    // Ya navegan, pero por el otro equipo de su sede: la ficha tiene mal la tecnología.
    yaEstanEnOtroEquipoDeLaSede: r.enOtroEquipoDeLaSede,
    rechazadosPorElRouter: r.noSePudoCrear,
  });
  if (r.muestra.length) {
    console.log(`\nMuestra (${r.muestra.length} de ${r.corregidos + r.creados}):`);
    for (const m of r.muestra) console.log(`  ${m.abonado ?? '—'} ${m.usuario} · ${m.router} · ${m.cambios}`);
  }
  if (r.faltantes.length) {
    console.log(`\nSin secret y sin poder crearlo (${r.faltantes.length}${r.faltantes.length >= 300 ? ' primeros' : ''}):`);
    for (const f of r.faltantes) console.log(`  ${f.abonado ?? '—'} ${f.usuario} · ${f.router} · ${f.motivo}`);
  }
  if (!aplicar) console.log('\nInforme: no se escribió nada. Repita con --aplicar para hacerlo de verdad.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
