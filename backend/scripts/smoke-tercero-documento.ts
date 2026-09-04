/**
 * Smoke del ALTA DE TERCERO desde el movimiento de tesorería
 * (`POST /treasury/beneficiaries`), contra la base de VERDAD:
 *
 *   npm run smoke:tercero-documento
 *
 * Comprueba la regla que promete el formulario del egreso:
 *   1. el documento (NIT o cédula) es OBLIGATORIO y la regla vive en el backend,
 *      no sólo en la pantalla —tampoco vale un "12" que no identifica a nadie—,
 *   2. el documento se guarda tal cual lo escriben,
 *   3. el mismo documento escrito de otra forma —con puntos, sin guión— y con otro
 *      nombre NO crea un segundo tercero: devuelve el que ya está,
 *   4. al tercero que ya existía SIN documento (los de antes de este campo) se le
 *      completa en vez de duplicarlo,
 *   5. un documento distinto sobre un nombre que ya existe no le pisa el suyo.
 *
 * Lo que crea se borra al final (los terceros del smoke no los referencia nadie).
 */
import 'reflect-metadata';
import { cobranzasService, prismaService } from '../src/core/contenedor';

let fallos = 0;
function check(ok: boolean, texto: string) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${texto}`);
  if (!ok) fallos++;
}

/** El alta debe reventar: se comprueba el motivo, no sólo que falle. */
async function rechaza(dto: any, texto: string) {
  try {
    const creado = await cobranzasService.createBeneficiary(dto);
    await prismaService.supplier.delete({ where: { id: creado.id } }).catch(() => {});
    check(false, `${texto} (NO falló: creó ${creado.id})`);
  } catch (e: any) {
    check(/NIT o la cédula/i.test(e?.message || ''), `${texto} — ${e?.message?.slice(0, 60)}…`);
  }
}

async function main() {
  const sello = Date.now();
  const conDoc = `SMOKE Tercero Doc ${sello}`;
  const otroNombre = `SMOKE Tercero Doc ${sello} (mal escrito)`;
  const viejo = `SMOKE Tercero Viejo ${sello}`;
  const creados: string[] = [];

  try {
    // 1 · sin documento no hay alta
    await rechaza({ name: conDoc }, 'sin documento el alta se rechaza');
    await rechaza({ name: conDoc, nit: '  ' }, 'un documento en blanco no cuela');
    await rechaza({ name: conDoc, nit: '12' }, 'un documento de 2 caracteres tampoco');
    const huerfano = await prismaService.supplier.count({ where: { name: conDoc } });
    check(huerfano === 0, 'ningún tercero quedó creado en los intentos rechazados');

    // 2 · el documento se guarda tal cual
    const a = await cobranzasService.createBeneficiary({ name: conDoc, nit: '900.123.456-7' });
    creados.push(a.id);
    check(a.nit === '900.123.456-7', `se guarda el documento tal cual se escribió (${a.nit})`);
    check(a.category === 3, 'entra como TERCERO (categoría 3)');

    // 3 · mismo documento, otra forma de escribirlo y otro nombre → el que ya está
    const b = await cobranzasService.createBeneficiary({ name: otroNombre, nit: '9001234567' });
    check(b.id === a.id, 'el mismo documento sin puntos ni guión NO crea un duplicado');
    check(b.name === conDoc, `devuelve el que ya estaba, con su nombre (${b.name})`);

    // 4 · al que venía sin documento (dado de alta antes) se le completa
    const previo = await prismaService.supplier.create({
      data: { name: viejo, category: 3 },
      select: { id: true },
    });
    creados.push(previo.id);
    const c = await cobranzasService.createBeneficiary({ name: viejo, nit: '1098765432' });
    check(c.id === previo.id, 'volver a escribirlo con documento no crea un segundo tercero');
    check(c.nit === '1098765432', 'al que no tenía documento se le completa');

    // 5 · no se le pisa el documento a quien ya tiene uno
    const d = await cobranzasService.createBeneficiary({ name: viejo, nit: '5555555555' });
    check(d.id === previo.id && d.nit === '1098765432', 'un documento distinto NO pisa el que ya estaba guardado');

    // 6 · el directorio lo encuentra por documento (el buscador ya miraba nit)
    const lista = await cobranzasService.beneficiaries({ search: '900.123.456-7' });
    check(lista.some((x) => x.id === a.id), 'sale en el directorio buscando por su documento');
  } finally {
    if (creados.length) {
      await prismaService.supplier.deleteMany({ where: { id: { in: creados } } });
      console.log(`\n  (limpieza: ${creados.length} terceros de prueba borrados)`);
    }
  }

  console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo bien.');
  process.exit(fallos ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
