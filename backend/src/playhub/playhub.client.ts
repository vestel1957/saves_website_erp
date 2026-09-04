import { Logger } from '../core/logger';

export type PlayhubResp<T = any> = { httpCode: number; data: T | null; error?: string | null };

/** Catálogo de productos PlayHub (código → nombre, categoría, si lo asigna el operador por API). */
export const PLAYHUB_CATALOG: Record<string, { name: string; assignable: boolean; category: string }> = {
  PKD: { name: 'PlayKids+', assignable: false, category: 'PPA' },
  K26: { name: 'Kaspersky Standard - 1 Lic. LA', assignable: false, category: 'PPA' },
  A3P: { name: 'A3Player', assignable: false, category: 'PPA' },
  CIN: { name: 'Cindie', assignable: false, category: 'PPA' },
  Q01: { name: '01 Servicio a elegir', assignable: true, category: 'RQC' },
  Q02: { name: '02 Servicios a elegir', assignable: true, category: 'RQC' },
  Q03: { name: '03 Servicios a elegir', assignable: true, category: 'RQC' },
  Q04: { name: '04 Servicios a elegir', assignable: true, category: 'RQC' },
  SUR: { name: 'Sura', assignable: false, category: 'PPP' },
  K28: { name: 'Kaspersky Standard - 5 Lic. LA', assignable: false, category: 'PPP' },
  DIC: { name: 'Disney+ Plan Estándar con Anuncios CO', assignable: false, category: 'PPP' },
  DTX: { name: 'DIRECTV Ultra Lite CO', assignable: false, category: 'PPP' },
  P01: { name: '01 Servicio premium a elegir', assignable: true, category: 'RQP' },
  P02: { name: '02 Servicios premium a elegir', assignable: true, category: 'RQP' },
  P03: { name: '03 Servicios premium a elegir', assignable: true, category: 'RQP' },
  P04: { name: '04 Servicios premium a elegir', assignable: true, category: 'RQP' },
  ZW1: { name: 'ZenWellness', assignable: false, category: 'PPS' },
  QD3: { name: 'Quema Diaria LATAM', assignable: false, category: 'PPS' },
  SXH: { name: 'HotGo', assignable: false, category: 'PPS' },
  DIA: { name: 'Disney+ Plan Estándar CO', assignable: false, category: 'PPS' },
  DTY: { name: 'DIRECTV Flex CO', assignable: false, category: 'PPS' },
  DUB: { name: 'DIRECTV Ultra Lite + Amazon CO', assignable: false, category: 'PPS' },
  S01: { name: '01 Servicio premium plus a elegir', assignable: true, category: 'RQS' },
  S02: { name: '02 Servicios premium plus a elegir', assignable: true, category: 'RQS' },
  S03: { name: '03 Servicios premium plus a elegir', assignable: true, category: 'RQS' },
  S04: { name: '04 Servicios premium plus a elegir', assignable: true, category: 'RQS' },
  S05: { name: '05 Servicios premium plus a elegir', assignable: true, category: 'RQS' },
  S06: { name: '06 Servicios premium plus a elegir', assignable: true, category: 'RQS' },
  K21: { name: 'Kaspersky Plus - 5 Lic. LA', assignable: false, category: 'PPU' },
  DIB: { name: 'Disney+ Plan Premium CO', assignable: false, category: 'PPU' },
  DTZ: { name: 'DIRECTV Flex + Amazon CO', assignable: false, category: 'PPU' },
  DU0: { name: 'DIRECTV Win Sport + UL CO', assignable: false, category: 'PPU' },
  U01: { name: '01 Servicio diamante a elegir', assignable: true, category: 'RQU' },
  U02: { name: '02 Servicios diamante a elegir', assignable: true, category: 'RQU' },
  U03: { name: '03 Servicios diamante a elegir', assignable: true, category: 'RQU' },
  U04: { name: '04 Servicios diamante a elegir', assignable: true, category: 'RQU' },
  U05: { name: '05 Servicios diamante a elegir', assignable: true, category: 'RQU' },
};

const ERROR_CODES: Record<number, string> = {
  2: 'El usuario ya está registrado en PlayHub',
  3: 'Número de documento inválido',
  4: 'Suscripción no encontrada',
  5: 'Código de producto inválido',
  6: 'Producto no autorizado para este socio',
  7: 'El cliente ya tiene una suscripción a este producto',
  8: 'No hay vouchers disponibles para este producto',
};

export function playhubProductName(code: string): string {
  return PLAYHUB_CATALOG[code]?.name ?? code;
}

/**
 * Nombre comercial del área a la que pertenece cada categoría de producto.
 *
 * Las categorías de PlayHub vienen en clave (PPA, PPP, …) y son las mismas
 * "áreas" con las que se vende aquí: PPx son las apps de esa área y RQx el cupo
 * ("02 Servicios a elegir") con el que el cliente escoge entre ellas.
 */
export const PLAYHUB_AREA_LABEL: Record<string, string> = {
  PPA: 'Standard',
  RQC: 'Standard',
  PPP: 'Premium',
  RQP: 'Premium',
  PPS: 'Premium Plus',
  RQS: 'Premium Plus',
  PPU: 'Diamante',
  RQU: 'Diamante',
};

/** Escalera comercial: de la más básica a la más alta (no es el orden alfabético). */
const ORDEN_AREAS = ['PPA', 'PPP', 'PPS', 'PPU'];

/** Área a la que pertenece un producto del catálogo (o su categoría cruda). */
export function playhubAreaLabel(code: string): string {
  const cat = PLAYHUB_CATALOG[code]?.category ?? '';
  return PLAYHUB_AREA_LABEL[cat] ?? cat;
}

/** ¿Es una app que puede ELEGIR el cliente (y no un cupo que asigna el operador)? */
export function esAppElegible(code: string): boolean {
  const p = PLAYHUB_CATALOG[code];
  return !!p && !p.assignable;
}

/**
 * Las apps que el CLIENTE elige: las que el operador no asigna por API.
 *
 * Las asignables (Q0x/P0x/S0x/U0x) no son apps sino el cupo que se le vende
 * —"02 Servicios premium a elegir"—, así que no van en un selector de apps.
 */
export function playhubSelectableApps(): { code: string; name: string; area: string; category: string }[] {
  return Object.entries(PLAYHUB_CATALOG)
    .filter(([, v]) => !v.assignable)
    .map(([code, v]) => ({ code, name: v.name, area: playhubAreaLabel(code), category: v.category }))
    .sort(
      (a, b) =>
        ORDEN_AREAS.indexOf(a.category) - ORDEN_AREAS.indexOf(b.category) ||
        a.name.localeCompare(b.name, 'es'),
    );
}

/**
 * Normaliza el correo para PlayHub: el TLD debe terminar en .br. Reemplaza la
 * terminación .com.co / .com / .co por .br (el orden importa: .com.co primero).
 */
export function normalizeEmailBr(email: string): string {
  const e = (email || '').trim();
  if (!e) return e;
  return e.replace(/\.(com\.co|com|co)$/i, '.br');
}

export function playhubErrorMessage(resp: PlayhubResp): string {
  const code = resp?.data?.Code != null ? Number(resp.data.Code) : null;
  if (code && ERROR_CODES[code]) return ERROR_CODES[code];
  if (resp?.data?.Message) return String(resp.data.Message);
  return `Error HTTP ${resp.httpCode}`;
}

/** Tope de espera por petición, como el `CURLOPT_TIMEOUT` del legacy. */
const TIMEOUT_MS = 20_000;

/**
 * Cliente de la API de PlayHub (IPTV/OTT), portado de la librería legacy
 * `Playhub.php`. Auth por token (POST /authentication/tokens con ApiKey/ApiSecret),
 * cacheado ~25 min; reintenta una vez ante 401/403. Config por variables de
 * entorno: PLAYHUB_BASE_URL, PLAYHUB_API_KEY, PLAYHUB_API_SECRET.
 *
 * La URL por defecto es la de PRODUCCIÓN —la misma que el legacy tiene guardada en
 * `variables_de_entorno`—: las credenciales del operador no valen contra el sandbox,
 * así que apuntar ahí por defecto sólo servía para dar 401 con las claves buenas.
 */
export class PlayhubClient {
  private readonly logger = new Logger('PlayhubClient');
  private token: string | null = null;
  private tokenExp = 0;
  /** Petición de token en vuelo: evita que un lote en paralelo pida N tokens a la vez. */
  private tokenEnVuelo: Promise<string | null> | null = null;

  private get baseUrl() {
    return (process.env.PLAYHUB_BASE_URL ?? 'https://www.playhub.com.br/API/PlayhubApi').replace(/\/+$/, '');
  }
  private get apiKey() {
    return (process.env.PLAYHUB_API_KEY ?? '').replace(/\s+/g, '');
  }
  private get apiSecret() {
    return (process.env.PLAYHUB_API_SECRET ?? '').replace(/\s+/g, '');
  }
  get isConfigured() {
    return !!this.apiKey && !!this.apiSecret;
  }

  status() {
    return { configured: this.isConfigured, baseUrl: this.baseUrl };
  }

  private async getToken(force = false): Promise<string | null> {
    if (!force && this.token && this.tokenExp > Date.now()) return this.token;
    if (this.tokenEnVuelo) return this.tokenEnVuelo;
    this.tokenEnVuelo = (async () => {
      const resp = await this.request('POST', '/api/v3/authentication/tokens', { ApiKey: this.apiKey, ApiSecret: this.apiSecret }, false);
      const tok = resp?.data?.AccessToken;
      if (tok) {
        this.token = tok;
        this.tokenExp = Date.now() + 1500 * 1000;
        return tok as string;
      }
      this.logger.warn(`No se pudo obtener token de PlayHub (HTTP ${resp.httpCode})`);
      return null;
    })().finally(() => { this.tokenEnVuelo = null; });
    return this.tokenEnVuelo;
  }

  // ---------- Customers ----------

  createCustomer(username: string, password: string, name: string, document = '', email = '', mobile = '') {
    const body: Record<string, string> = { Username: username, Password: password, Name: name };
    if (document) body.Document = document;
    if (email) body.Email = normalizeEmailBr(email);
    if (mobile) body.Mobile = mobile.replace(/\D/g, '');
    return this.request('POST', '/api/v3/customers', body);
  }

  updateCustomer(username: string, password: string, name: string, email = '', mobile = '') {
    const body: Record<string, string> = { Password: password, Name: name };
    if (email) body.Email = normalizeEmailBr(email);
    if (mobile) body.Mobile = mobile.replace(/\D/g, '');
    return this.request('PUT', `/api/v3/customers/${encodeURIComponent(username)}`, body);
  }

  getCustomer(username: string) {
    return this.request('GET', `/api/v3/customers/${encodeURIComponent(username)}`);
  }

  // ---------- Subscriptions ----------

  getSubscriptions(username: string) {
    return this.request('GET', `/api/v3/customers/${encodeURIComponent(username)}/subscriptions`);
  }

  /**
   * Suscripciones de MUCHOS logins a la vez (equivalente del `curl_multi` del
   * legacy). La API no expone un listado masivo, así que la barrida completa son
   * ~15.000 GET: en serie tardaría horas, por lotes de `concurrency` baja a minutos.
   * Un 401/403 en el lote se trata como token caducado: se refresca y se repite.
   */
  async getSubscriptionsMulti(usernames: string[], concurrency = 30): Promise<Map<string, PlayhubResp>> {
    const out = new Map<string, PlayhubResp>();
    const unicos = [...new Set(usernames)];
    if (!this.isConfigured) {
      for (const u of unicos) out.set(u, { httpCode: 0, data: null, error: 'PlayHub no configurado' });
      return out;
    }
    // Un token para toda la barrida: si no, el primer lote pediría 30 a la vez.
    if (!(await this.getToken())) {
      for (const u of unicos) out.set(u, { httpCode: 403, data: null, error: 'No se pudo obtener token' });
      return out;
    }
    const tam = Math.max(1, Math.min(50, concurrency));
    for (let i = 0; i < unicos.length; i += tam) {
      const lote = unicos.slice(i, i + tam);
      let res = await Promise.all(lote.map((u) => this.getSubscriptions(u)));
      // El reintento por 401/403 ya vive en `request`; aquí sólo se recogen.
      lote.forEach((u, j) => out.set(u, res[j]));
      res = [];
    }
    return out;
  }

  createSubscription(username: string, productId: string) {
    return this.request('POST', `/api/v3/customers/${encodeURIComponent(username)}/subscriptions`, { ProductId: productId });
  }

  deleteSubscription(username: string, productId: string) {
    return this.request('DELETE', `/api/v3/customers/${encodeURIComponent(username)}/subscriptions/${encodeURIComponent(productId)}`);
  }

  // ---------- HTTP ----------

  private async request(method: string, path: string, body?: any, auth = true): Promise<PlayhubResp> {
    if (!this.isConfigured) return { httpCode: 0, data: null, error: 'PlayHub no configurado' };
    const doFetch = async (token: string | null): Promise<PlayhubResp> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (auth && token) headers['authorization'] = `bearer ${token}`;
      try {
        const res = await fetch(this.baseUrl + path, {
          method,
          headers,
          body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text();
        let data: any = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        return { httpCode: res.status, data, error: null };
      } catch (e) {
        return { httpCode: 0, data: null, error: (e as Error).message };
      }
    };

    let token: string | null = null;
    if (auth) {
      token = await this.getToken();
      if (!token) return { httpCode: 403, data: null, error: 'No se pudo obtener token' };
    }
    let resp = await doFetch(token);
    // Token expirado/ inválido → refrescar y reintentar una vez.
    if (auth && (resp.httpCode === 401 || resp.httpCode === 403)) {
      token = await this.getToken(true);
      if (token) resp = await doFetch(token);
    }
    return resp;
  }
}
