/**
 * CORTES DESHECHOS: clientes cortados por mora que el router vuelve a tener navegando
 * sin que nadie haya cobrado ni reconectado.
 *
 * Por qué existe (2026-09-14). El 01-09-2026, entre las 19:02 y las 19:42, 23 abonados
 * cortados el 24/25-08 volvieron a ACTIVOS en cuatro routers, uno detrás de otro, sin
 * pago, sin orden de reconexión y sin rastro en nexus ni en la bitácora del legacy
 * (abonado 51993, entre otros). El corte del legacy tampoco avisa cuando no llega al
 * router. En los dos casos la ficha dice "cortado" y el cliente navega, y nadie se
 * entera hasta que un asesor tropieza con él.
 *
 * Solo DETECTA: no corta a nadie. Cortar sigue siendo del legacy.
 */

/** Tipos de orden que dejan sin internet. La TV va por otro equipo y no se mira aquí. */
export const TIPOS_CORTE = ['Corte Internet', 'Corte Combo'];
export const TIPOS_RECONEXION = ['Reconexion Internet', 'Reconexion Internet2', 'Reconexion Combo'];

/** Estados a los que no toca cortar ni reconectar: bajas y suspensiones pedidas. */
export const ESTADOS_FUERA = ['RETIRADO', 'DEPURADO', 'POR_RETIRAR', 'INACTIVO', 'SUSPENDIDO'] as const;

/**
 * Deuda vencida mínima para dar un corte por vigente. Un saldo de centavos o de un
 * redondeo (abonado 55677: $3.850 tras pagar) no justifica mandar a nadie a cortar.
 */
export const DEUDA_MINIMA = 10_000;

/** `sede` es `Branch.legacyId` del abonado (null si no tiene): la misma llave que `Mikrotik.sedeLegacy`. */
export type Corte = { subscriberId: string; abonado: number; legacyId: number; sede: number | null; created: Date };
export type Reconexion = { subscriberId: string; created: Date };
export type FacturaVencida = { subscriberId: string; pendiente: number };

export type Candidato = { subscriberId: string; abonado: number; legacyId: number; sede: number | null; corte: Date; deudaVencida: number };

/**
 * Quién sigue cortado según las órdenes y la cartera: su último corte de internet no
 * tiene reconexión el mismo día o después, y todavía debe algo vencido que valga la pena.
 */
export function candidatosDeCorte(
  cortes: Corte[],
  reconexiones: Reconexion[],
  vencidas: FacturaVencida[],
  minimo = DEUDA_MINIMA,
): Candidato[] {
  const ultimoCorte = new Map<string, Corte>();
  for (const c of cortes) {
    const previo = ultimoCorte.get(c.subscriberId);
    if (!previo || c.created > previo.created) ultimoCorte.set(c.subscriberId, c);
  }
  const deuda = new Map<string, number>();
  for (const f of vencidas) deuda.set(f.subscriberId, (deuda.get(f.subscriberId) ?? 0) + f.pendiente);

  const salida: Candidato[] = [];
  for (const c of ultimoCorte.values()) {
    // `created` es solo fecha: una reconexión del mismo día cuenta como posterior.
    if (reconexiones.some((r) => r.subscriberId === c.subscriberId && r.created >= c.created)) continue;
    const debe = Math.round(deuda.get(c.subscriberId) ?? 0);
    if (debe < minimo) continue;
    salida.push({ subscriberId: c.subscriberId, abonado: c.abonado, legacyId: c.legacyId, sede: c.sede, corte: c.created, deudaVencida: debe });
  }
  return salida;
}

/** Lo que un router tiene en sus dos listas, por `comment` (= `activo_<legacyId>`). */
export type ListasDelRouter = { router: string; sede: number | null; activos: Map<string, string>; morosos: Set<string> };

export type CorteDeshecho = Candidato & { router: string; enActivosDesde: string };

/**
 * De los que siguen cortados, los que un router deja pasar: están en ACTIVOS y en
 * NINGÚN router de su sede están en MOROSOS. MOROSOS se mira en todos los de la sede
 * porque el legacy replica la lista ahí, y estar en ella en cualquiera ya bloquea.
 *
 * Solo cuentan los routers DE SU SEDE: los abonados 2385 y 52392 (Monterrey) tienen
 * una entrada vieja de 2025 en ACTIVOS de Tauramena, que no dice nada de si navegan.
 * Sin sede se miran todos, que es lo único que se puede hacer.
 */
export function cortesDeshechos(candidatos: Candidato[], todas: ListasDelRouter[]): CorteDeshecho[] {
  const salida: CorteDeshecho[] = [];
  for (const c of candidatos) {
    const comment = `activo_${c.legacyId}`;
    const listas = c.sede == null ? todas : todas.filter((l) => l.sede === c.sede);
    if (listas.some((l) => l.morosos.has(comment))) continue;
    const donde = listas.find((l) => l.activos.has(comment));
    if (!donde) continue;
    salida.push({ ...c, router: donde.router, enActivosDesde: donde.activos.get(comment) ?? '' });
  }
  return salida.sort((a, b) => b.deudaVencida - a.deudaVencida);
}
