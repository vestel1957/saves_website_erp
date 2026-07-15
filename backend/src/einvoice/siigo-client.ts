/**
 * Cliente HTTP de la API de Siigo (facturación electrónica DIAN Colombia).
 * Porta `SiigoAPI.php` del legacy: autenticación (username + access_key → token)
 * y creación de factura (POST /v1/invoices con Bearer). Usa fetch nativo (Node 20).
 *
 * El header `Partner-Id` es el identificador de integración de Vestel ante Siigo.
 */
const PARTNER_ID = process.env.SIIGO_PARTNER_ID ?? 'savescrmintegrationsiigo';

export interface SiigoAuthResult {
  access_token: string;
  expires_in?: number;
}

export interface SiigoInvoiceResult {
  ok: boolean;
  httpCode: number;
  /** id (uuid) de la factura en Siigo */
  id?: string;
  /** número DIAN con prefijo (p.ej. "SETP990000001") */
  number?: string;
  /** CUFE / sello electrónico */
  cufe?: string;
  /** URL pública del PDF */
  pdfUrl?: string;
  raw: any;
  error?: string;
}

export class SiigoClient {
  constructor(
    private readonly authUrl: string,
    private readonly apiBaseUrl: string,
  ) {}

  /** Autentica y devuelve el access_token. Lanza en credenciales inválidas. */
  async authenticate(username: string, accessKey: string): Promise<SiigoAuthResult> {
    const res = await fetch(this.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Partner-Id': PARTNER_ID },
      body: JSON.stringify({ username, access_key: accessKey }),
    });
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error(`Siigo auth ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    if (!json.access_token) throw new Error('Siigo auth: respuesta sin access_token');
    return json;
  }

  /**
   * ¿Existe el tercero en Siigo? (GET /v1/customers?identification=…). Porta
   * `SiigoAPI::getCustomer1`. `found=null` ⇒ no se pudo consultar (no afirmar que falta).
   */
  async findCustomer(token: string, identification: string): Promise<{ ok: boolean; found: boolean | null; id?: string; error?: string }> {
    const res = await fetch(`${this.apiBaseUrl}/customers?identification=${encodeURIComponent(identification)}`, {
      headers: { 'Partner-Id': PARTNER_ID, Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let raw: any;
    try { raw = JSON.parse(text); } catch { raw = text; }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, found: null, error: typeof raw === 'string' ? raw.slice(0, 300) : JSON.stringify(raw).slice(0, 300) };
    }
    const total = raw?.pagination?.total_results;
    const first = raw?.results?.[0];
    return { ok: true, found: Number(total) > 0, id: first?.id };
  }

  /** Crea el tercero en Siigo (POST /v1/customers). Porta `SiigoAPI::saveCustomer1`. */
  async createCustomer(token: string, payload: unknown): Promise<{ ok: boolean; id?: string; raw: any; error?: string }> {
    const res = await fetch(`${this.apiBaseUrl}/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Partner-Id': PARTNER_ID, Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let raw: any;
    try { raw = JSON.parse(text); } catch { raw = text; }
    if (res.status >= 200 && res.status < 300) return { ok: true, id: raw?.id, raw };
    const errMsg = Array.isArray(raw?.Errors)
      ? raw.Errors.map((e: any) => e.Message ?? e.message).join(' | ')
      : typeof raw === 'string' ? raw.slice(0, 300) : JSON.stringify(raw).slice(0, 300);
    return { ok: false, raw, error: errMsg };
  }

  /** Crea la factura electrónica. `token` = Bearer vigente; `payload` = cuerpo Siigo. */
  async createInvoice(token: string, payload: unknown): Promise<SiigoInvoiceResult> {
    const res = await fetch(`${this.apiBaseUrl}/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Partner-Id': PARTNER_ID,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text;
    }
    if (res.status >= 200 && res.status < 300) {
      // Siigo devuelve stamp con cufe + public_url del PDF cuando la factura es electrónica.
      return {
        ok: true,
        httpCode: res.status,
        id: raw?.id,
        number: raw?.number != null ? String(raw.number) : raw?.name,
        cufe: raw?.stamp?.cufe ?? raw?.metadata?.cufe,
        pdfUrl: raw?.public_url ?? raw?.pdf_url,
        raw,
      };
    }
    // error: Siigo devuelve {Errors:[{Code,Message}]}
    const errMsg = Array.isArray(raw?.Errors)
      ? raw.Errors.map((e: any) => e.Message ?? e.message).join(' | ')
      : typeof raw === 'string'
        ? raw.slice(0, 400)
        : JSON.stringify(raw).slice(0, 400);
    return { ok: false, httpCode: res.status, raw, error: errMsg };
  }

  /**
   * Crea una NOTA CRÉDITO electrónica ante la DIAN (POST /v1/credit-notes).
   * El payload debe referenciar la factura original (invoice = uuid Siigo) y
   * llevar el `document.id` del comprobante de nota crédito. Mismo contrato de
   * respuesta que createInvoice (id/number/cufe/pdfUrl).
   */
  async createCreditNote(token: string, payload: unknown): Promise<SiigoInvoiceResult> {
    const res = await fetch(`${this.apiBaseUrl}/credit-notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Partner-Id': PARTNER_ID,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let raw: any;
    try { raw = JSON.parse(text); } catch { raw = text; }
    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        httpCode: res.status,
        id: raw?.id,
        number: raw?.number != null ? String(raw.number) : raw?.name,
        cufe: raw?.stamp?.cufe ?? raw?.metadata?.cufe,
        pdfUrl: raw?.public_url ?? raw?.pdf_url,
        raw,
      };
    }
    const errMsg = Array.isArray(raw?.Errors)
      ? raw.Errors.map((e: any) => e.Message ?? e.message).join(' | ')
      : typeof raw === 'string' ? raw.slice(0, 400) : JSON.stringify(raw).slice(0, 400);
    return { ok: false, httpCode: res.status, raw, error: errMsg };
  }
}
