/**
 * Festivos colombianos — port 1:1 de `application/libraries/Festivos.php` del legacy
 * (saves-vestel), incluida la ley Emiliani.
 *
 * Por qué importa tanto la fidelidad: el cierre de caja arrastra el excedente al
 * PRÓXIMO DÍA HÁBIL escribiendo una transacción con esa fecha. Un festivo de más o de
 * menos mueve dinero de día en el libro.
 *
 * Regla del legacy (verificada contra los cierres reales de producción): sólo se saltan
 * DOMINGOS y festivos. **El sábado ES día hábil.**
 *   - sáb 2026-06-27 -> mar 2026-06-30 (salta domingo 28 y lunes 29 = San Pedro y San Pablo)
 *   - sáb 2026-07-04 -> lun 2026-07-06
 *
 * Todo se calcula en UTC (igual que `dateOnly`) para que un cambio de horario no
 * corra una fecha.
 */

/** Días que hay que sumar para caer en el lunes siguiente, según el día de la semana (0 = domingo). */
const SALTO_EMILIANI: Record<number, number> = {
  0: 1, // domingo -> lunes
  1: 0, // lunes: ya está
  2: 6, // martes
  3: 5, // miércoles
  4: 4, // jueves
  5: 3, // viernes
  6: 2, // sábado
};

const mmdd = (mes: number, dia: number) =>
  `${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

/**
 * Domingo de Pascua (computus gregoriano). Equivale a `easter_date()` de PHP,
 * que es lo que usa el legacy para derivar la semana santa y los festivos móviles.
 */
function pascua(ano: number): { mes: number; dia: number } {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return { mes: Math.floor(n / 31), dia: (n % 31) + 1 };
}

const cache = new Map<number, Set<string>>();

/** Festivos de un año como claves 'MM-DD' (mismo modelo que `festivos[ano][mes][dia]` del legacy). */
export function festivosDe(ano: number): Set<string> {
  const yaEsta = cache.get(ano);
  if (yaEsta) return yaEsta;

  const set = new Set<string>();

  // Normaliza desbordes de mes/día igual que mktime() de PHP (ej: 29-jun + 6 -> 5-jul).
  const agregar = (mes: number, dia: number) => {
    const d = new Date(Date.UTC(ano, mes - 1, dia));
    set.add(mmdd(d.getUTCMonth() + 1, d.getUTCDate()));
  };

  /** Ley Emiliani: los festivos que no caen en lunes se trasladan al lunes siguiente. */
  const emiliani = (mes: number, dia: number) => {
    const diaSemana = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
    agregar(mes, dia + SALTO_EMILIANI[diaSemana]);
  };

  // Fijos (no se mueven).
  agregar(1, 1); //  Primero de Enero
  agregar(5, 1); //  Día del Trabajo
  agregar(7, 20); // Independencia
  agregar(8, 7); //  Batalla de Boyacá
  agregar(12, 8); // María Inmaculada
  agregar(12, 25); // Navidad

  // Bajo ley Emiliani.
  emiliani(1, 6); //   Reyes Magos
  emiliani(3, 19); //  San José
  emiliani(6, 29); //  San Pedro y San Pablo
  emiliani(8, 15); //  Asunción
  emiliani(10, 12); // Descubrimiento de América
  emiliani(11, 1); //  Todos los Santos
  emiliani(11, 11); // Independencia de Cartagena

  // Derivados de la Pascua.
  const p = pascua(ano);
  const desdePascua = (dias: number) => {
    const d = new Date(Date.UTC(ano, p.mes - 1, p.dia + dias));
    return { mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
  };

  const jueves = desdePascua(-3);
  agregar(jueves.mes, jueves.dia); // Jueves Santo (no se mueve)
  const viernes = desdePascua(-2);
  agregar(viernes.mes, viernes.dia); // Viernes Santo (no se mueve)

  for (const dias of [43, 64, 71]) {
    // Ascensión, Corpus Christi, Sagrado Corazón: se trasladan al lunes siguiente.
    const f = desdePascua(dias);
    emiliani(f.mes, f.dia);
  }

  cache.set(ano, set);
  return set;
}

export function esFestivo(fecha: Date): boolean {
  return festivosDe(fecha.getUTCFullYear()).has(
    mmdd(fecha.getUTCMonth() + 1, fecha.getUTCDate()),
  );
}

export function esDomingo(fecha: Date): boolean {
  return fecha.getUTCDay() === 0;
}

/**
 * Próximo día hábil DESPUÉS de `fecha`: arranca en el día siguiente y avanza mientras
 * caiga en domingo o festivo. Es a donde el cierre manda el excedente del día.
 * Réplica de `sacar_pdf()` en Reports.php (~líneas 634-639).
 */
export function proximoDiaHabil(fecha: Date): Date {
  const d = new Date(fecha.getTime());
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (esFestivo(d) || esDomingo(d));
  return d;
}
