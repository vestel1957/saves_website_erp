import {
  detectarSenales,
  fotoEnOtroSitio,
  esIpDeOficina,
  precisionSospechosa,
  puntoRepetido,
  saltoImposible,
} from './spoof.policy';

const CASA = { lat: 5.3407689, lng: -72.369472 };
const OFICINA = { lat: 5.3378, lng: -72.3959 };
/** Bogotá: a ~230 km. Llegar en minutos no lo hace nadie. */
const LEJOS = { lat: 4.711, lng: -74.0721 };
const t = (min: number) => new Date(Date.UTC(2026, 6, 20, 12, min, 0));

describe('precisionSospechosa', () => {
  it('marca una precisión que ningún GPS de teléfono alcanza', () => {
    expect(precisionSospechosa(0)).toBe(true);
    expect(precisionSospechosa(1)).toBe(true);
  });

  it('no molesta con precisiones normales', () => {
    expect(precisionSospechosa(5)).toBe(false);
    expect(precisionSospechosa(35)).toBe(false);
    expect(precisionSospechosa(null)).toBe(false);
  });
});

describe('puntoRepetido', () => {
  it('detecta la coordenada calcada, que un GPS real nunca repite', () => {
    expect(puntoRepetido(CASA, [{ lat: 5.3407689, lng: -72.369472 }])).toBe(true);
  });

  it('el ruido normal del receptor no se marca', () => {
    expect(puntoRepetido(CASA, [{ lat: 5.3407712, lng: -72.3694689 }])).toBe(false);
    expect(puntoRepetido(CASA, [])).toBe(false);
  });
});

describe('saltoImposible', () => {
  it('marca 230 km en diez minutos: eso no lo hace nadie', () => {
    expect(saltoImposible({ ...LEJOS, en: t(10) }, { ...CASA, en: t(0) })).toBe(true);
  });

  it('NO marca a quien va por la vía entre sedes a velocidad de carretera', () => {
    // 2,9 km en 2 min ≈ 88 km/h. En la vía Yopal–Villanueva es normal, y acusar
    // a un técnico por conducir sería el peor falso positivo posible.
    expect(saltoImposible({ ...CASA, en: t(2) }, { ...OFICINA, en: t(0) })).toBe(false);
  });

  it('el mismo trayecto en media hora es perfectamente normal', () => {
    expect(saltoImposible({ ...CASA, en: t(30) }, { ...OFICINA, en: t(0) })).toBe(false);
  });

  it('dos lecturas seguidas no se marcan aunque salten: es error de medición', () => {
    expect(
      saltoImposible({ ...CASA, en: new Date(t(0).getTime() + 20_000) }, { ...OFICINA, en: t(0) }),
    ).toBe(false);
  });

  it('sin punto anterior no hay nada que comparar', () => {
    expect(saltoImposible({ ...CASA, en: t(0) }, null)).toBe(false);
  });
});

describe('esIpDeOficina', () => {
  const oficinas = ['190.14.232.142'];

  it('marca al técnico que cierra desde el wifi de la oficina', () => {
    expect(esIpDeOficina('190.14.232.142', oficinas)).toBe(true);
  });

  it('desde datos móviles no concluye nada', () => {
    expect(esIpDeOficina('181.50.22.7', oficinas)).toBe(false);
    expect(esIpDeOficina(null, oficinas)).toBe(false);
  });

  it('tolera el prefijo IPv6-mapeado que mete el proxy', () => {
    expect(esIpDeOficina('::ffff:190.14.232.142', oficinas)).toBe(true);
  });

  it('sin oficinas configuradas no marca nada (es config opcional)', () => {
    expect(esIpDeOficina('190.14.232.142', [])).toBe(false);
  });
});

describe('fotoEnOtroSitio', () => {
  it('marca cuando la evidencia se tomó a kilómetros del cierre', () => {
    expect(fotoEnOtroSitio(CASA, [OFICINA])).toBe(true);
  });

  it('basta con que UNA foto cuadre: el técnico se mueve por la vivienda', () => {
    expect(fotoEnOtroSitio(CASA, [OFICINA, { lat: 5.3409, lng: -72.3695 }])).toBe(false);
  });

  it('sin fotos no se concluye nada', () => {
    expect(fotoEnOtroSitio(CASA, [])).toBe(false);
  });
});

describe('detectarSenales', () => {
  const limpio = {
    punto: { ...CASA, accuracyM: 12, en: t(30) },
    anterior: { ...OFICINA, en: t(0) },
    puntosPrevios: [{ lat: 5.3401, lng: -72.3688 }],
    ip: '181.50.22.7',
    oficinas: ['190.14.232.142'],
    fotos: [{ lat: 5.3409, lng: -72.3695 }],
  };

  it('un cierre honesto no dispara ninguna señal', () => {
    expect(detectarSenales(limpio)).toEqual([]);
  });

  it('un cierre falseado a lo bruto las dispara casi todas', () => {
    const senales = detectarSenales({
      ...limpio,
      // Precisión perfecta, punto calcado, teletransporte, desde la oficina, y
      // con la foto en otro sitio.
      punto: { ...CASA, accuracyM: 0, en: t(2) },
      anterior: { ...LEJOS, en: t(0) },
      puntosPrevios: [CASA],
      ip: '190.14.232.142',
      fotos: [OFICINA],
    });
    expect(senales).toEqual(
      expect.arrayContaining([
        'precision-perfecta',
        'punto-repetido',
        'salto-imposible',
        'desde-la-oficina',
        'foto-en-otro-sitio',
      ]),
    );
  });
});
