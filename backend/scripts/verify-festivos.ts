import { festivosDe, proximoDiaHabil } from '../src/common/festivos';

// Golden dataset extraído ejecutando el propio Festivos.php del legacy.
const GOLDEN: Record<number, string[]> = {
  2024: ["2024-01-01","2024-01-08","2024-03-25","2024-03-28","2024-03-29","2024-05-01","2024-05-13","2024-06-03","2024-06-10","2024-07-01","2024-07-20","2024-08-07","2024-08-19","2024-10-14","2024-11-04","2024-11-11","2024-12-08","2024-12-25"],
  2025: ["2025-01-01","2025-01-06","2025-03-24","2025-04-17","2025-04-18","2025-05-01","2025-06-02","2025-06-23","2025-06-30","2025-07-20","2025-08-07","2025-08-18","2025-10-13","2025-11-03","2025-11-17","2025-12-08","2025-12-25"],
  2026: ["2026-01-01","2026-01-12","2026-03-23","2026-04-02","2026-04-03","2026-05-01","2026-05-18","2026-06-08","2026-06-15","2026-06-29","2026-07-20","2026-08-07","2026-08-17","2026-10-12","2026-11-02","2026-11-16","2026-12-08","2026-12-25"],
  2027: ["2027-01-01","2027-01-11","2027-03-22","2027-03-25","2027-03-26","2027-05-01","2027-05-10","2027-05-31","2027-06-07","2027-07-05","2027-07-20","2027-08-07","2027-08-16","2027-10-18","2027-11-01","2027-11-15","2027-12-08","2027-12-25"],
  2028: ["2028-01-01","2028-01-10","2028-03-20","2028-04-13","2028-04-14","2028-05-01","2028-05-29","2028-06-19","2028-06-26","2028-07-03","2028-07-20","2028-08-07","2028-08-21","2028-10-16","2028-11-06","2028-11-13","2028-12-08","2028-12-25"],
};

let fallos = 0;
for (const [anoStr, esperados] of Object.entries(GOLDEN)) {
  const ano = Number(anoStr);
  const obtenidos = [...festivosDe(ano)].map((k) => `${ano}-${k}`).sort();
  const ok = JSON.stringify(obtenidos) === JSON.stringify(esperados);
  if (!ok) {
    fallos++;
    console.log(`FALLO ${ano}`);
    console.log('  sobran : ', obtenidos.filter((d) => !esperados.includes(d)));
    console.log('  faltan : ', esperados.filter((d) => !obtenidos.includes(d)));
  } else {
    console.log(`OK ${ano} — ${obtenidos.length} festivos idénticos al legacy`);
  }
}

// Saltos reales observados en los cierres de producción.
const saltos: [string, string][] = [
  ['2026-06-27', '2026-06-30'], // sábado -> martes (domingo + San Pedro y San Pablo)
  ['2026-07-04', '2026-07-06'], // sábado -> lunes
  ['2026-07-16', '2026-07-17'], // jueves -> viernes
  ['2026-07-03', '2026-07-04'], // viernes -> SÁBADO (es hábil)
  ['2026-07-17', '2026-07-18'], // viernes -> sábado
  ['2026-12-24', '2026-12-26'], // salta Navidad (25) -> sábado 26
  ['2026-07-18', '2026-07-21'], // sábado -> martes (domingo 19 + Independencia 20)
];
for (const [desde, esperado] of saltos) {
  const got = proximoDiaHabil(new Date(`${desde}T00:00:00.000Z`)).toISOString().slice(0, 10);
  const ok = got === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${desde} -> ${got} (esperado ${esperado})`);
}

console.log(fallos === 0 ? '\nTODO OK: el port es idéntico al legacy' : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
