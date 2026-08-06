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

/**
 * Cliente de la API de PlayHub (IPTV/OTT), portado de la librería legacy
 * `Playhub.php`. Auth por token (POST /authentication/tokens con ApiKey/ApiSecret),
 * cacheado ~25 min; reintenta una vez ante 401/403. Config por variables de
 * entorno: PLAYHUB_BASE_URL, PLAYHUB_API_KEY, PLAYHUB_API_SECRET.
 */
export class PlayhubClient {
  private readonly logger = new Logger('PlayhubClient');
  private token: string | null = null;
  private tokenExp = 0;

  private get baseUrl() {
    return (process.env.PLAYHUB_BASE_URL ?? 'https://sandbox-api.playhub.com.br').replace(/\/+$/, '');
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
    const resp = await this.request('POST', '/api/v3/authentication/tokens', { ApiKey: this.apiKey, ApiSecret: this.apiSecret }, false);
    const tok = resp?.data?.AccessToken;
    if (tok) {
      this.token = tok;
      this.tokenExp = Date.now() + 1500 * 1000;
      return tok;
    }
    return null;
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
