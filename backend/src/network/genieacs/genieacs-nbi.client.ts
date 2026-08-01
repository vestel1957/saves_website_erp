/**
 * GenieacsNbi — cliente del Northbound Interface (NBI) de GenieACS.
 *
 * GenieACS NO se controla por TR-069 directo: el sistema habla con el NBI (API REST,
 * puerto 7557) y GenieACS es quien habla CWMP/TR-069 con los CPEs (puerto 7547).
 *
 * ⚠️ IDs de dispositivo: GenieACS devuelve `_id` con caracteres `%` LITERALES (guarda la
 * forma percent-encoded como id literal — ej. `%7C%C2%87y-W702XW%2DX...` en ONTs chinos con
 * bytes basura en el OUI). Para las RUTAS del NBI hay que encodear ESE id otra vez con
 * encodeURIComponent (`%`→`%25`), así el server lo decodifica de vuelta al id literal.
 * En ids limpios (ej. Huawei `00259E-EG8143A5-...`) encodeURIComponent es no-op. Verificado
 * en vivo: sin doble-encode → 404 "No such device"; con doble-encode → 200. Ver `enc()`.
 */

export interface NbiDevice {
  id: string; // _id verbatim (percent-encoded, apto para rutas del NBI)
  manufacturer: string | null;
  productClass: string | null;
  oui: string | null;
  serial: string | null;
  lastInform: string | null;
  tags: string[];
  pppUser: string | null;
  wanIp: string | null;
}

/** Proyección mínima para listar/inventariar sin traer el árbol completo. */
export const LIST_PROJECTION = [
  '_deviceId._Manufacturer',
  '_deviceId._ProductClass',
  '_deviceId._OUI',
  '_deviceId._SerialNumber',
  '_lastInform',
  '_tags',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
  // Respaldo de identidad: muchos CPEs no exponen el Username en el árbol WAN,
  // pero el ISP configura el usuario del abonado como ConnectionRequestUsername.
  'InternetGatewayDevice.ManagementServer.ConnectionRequestUsername',
];

/**
 * Error de una llamada al NBI que llegó con estado HTTP no-2xx. Lleva el `status`
 * para que el servicio distinga un 401/403 (auth) de un 5xx/timeout y devuelva un
 * mensaje accionable al operador.
 */
export class NbiError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`NBI ${path} → HTTP ${status}`);
    this.name = 'NbiError';
  }
  /** true si el NBI rechazó por autenticación (falta basic-auth o credenciales inválidas). */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Mensaje legible para el operador según el estado del NBI. */
export function nbiHttpMessage(status: number): string {
  if (status === 401) return 'El NBI exige autenticación y las credenciales faltan o son inválidas (401).';
  if (status === 403) return 'El NBI rechazó el acceso (403). Revisa las credenciales del servidor.';
  return `El NBI respondió HTTP ${status}.`;
}

/** Navega un path punteado del árbol TR-069 y devuelve el `_value` de la hoja. Exportado
 *  para que el servicio pueda leer parámetros puntuales (SSID/clave/TV) del CPE. */
export function leaf(obj: any, path: string): any {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur && typeof cur === 'object' ? cur._value : cur;
}

export class GenieacsNbi {
  private base: string;
  constructor(baseUrl: string, private user = '', private pass = '') {
    this.base = String(baseUrl || '').replace(/\/+$/, '');
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.user) h['Authorization'] = 'Basic ' + Buffer.from(`${this.user}:${this.pass}`).toString('base64');
    return h;
  }

  /** Encoda el _id (que ya trae `%` literales) para usarlo en rutas del NBI. Ver nota de cabecera. */
  private enc(deviceId: string): string {
    return encodeURIComponent(deviceId);
  }

  private async req(path: string, init: RequestInit = {}, timeoutMs = 45000): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(this.base + path, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** Prueba de conexión al NBI. */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await this.req('/devices/?projection=_id&limit=1', { headers: this.headers(false) }, 15000);
      return r.ok ? { ok: true } : { ok: false, error: nbiHttpMessage(r.status) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Consulta cruda a /devices con query Mongo-like + proyección. */
  async queryRaw(query: Record<string, any> | null, projection: string[], limit?: number): Promise<any[]> {
    const p = new URLSearchParams();
    if (query) p.set('query', JSON.stringify(query));
    if (projection?.length) p.set('projection', projection.join(','));
    if (limit) p.set('limit', String(limit));
    const r = await this.req('/devices/?' + p.toString(), { headers: this.headers(false) });
    if (!r.ok) throw new NbiError(r.status, '/devices');
    return (await r.json()) as any[];
  }

  /** Lista dispositivos normalizados (usa LIST_PROJECTION). */
  async listDevices(query: Record<string, any> | null = null, limit?: number): Promise<NbiDevice[]> {
    const rows = await this.queryRaw(query, LIST_PROJECTION, limit);
    return rows.map((d): NbiDevice => {
      const did = d._deviceId || {};
      const wanBase = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';
      return {
        id: d._id,
        manufacturer: did._Manufacturer ?? null,
        productClass: did._ProductClass ?? null,
        oui: did._OUI ?? null,
        serial: did._SerialNumber ?? null,
        lastInform: d._lastInform ?? null,
        tags: Array.isArray(d._tags) ? d._tags : [],
        pppUser: leaf(d, `${wanBase}.Username`)
          ?? leaf(d, 'InternetGatewayDevice.ManagementServer.ConnectionRequestUsername')
          ?? null,
        wanIp: leaf(d, `${wanBase}.ExternalIPAddress`) ?? null,
      };
    });
  }

  // ---- Escrituras (el id va VERBATIM en la ruta; ver nota de la cabecera) ----

  async addTag(deviceId: string, tag: string): Promise<boolean> {
    const r = await this.req(`/devices/${this.enc(deviceId)}/tags/${encodeURIComponent(tag)}`, { method: 'POST', headers: this.headers(false) });
    return r.ok;
  }

  async removeTag(deviceId: string, tag: string): Promise<boolean> {
    const r = await this.req(`/devices/${this.enc(deviceId)}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE', headers: this.headers(false) });
    return r.ok;
  }

  /** Encola una tarea. connectionRequest=true intenta ejecutarla de inmediato. */
  async pushTask(deviceId: string, task: Record<string, any>, connectionRequest = true): Promise<{ ok: boolean; status: number }> {
    const q = connectionRequest ? '?connection_request' : '';
    const r = await this.req(`/devices/${this.enc(deviceId)}/tasks${q}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(task) });
    return { ok: r.ok, status: r.status };
  }

  /** setParameterValues de un booleano (ej. corte/alta de TV). */
  setBool(deviceId: string, param: string, value: boolean, connectionRequest = true) {
    return this.pushTask(deviceId, { name: 'setParameterValues', parameterValues: [[param, value, 'xsd:boolean']] }, connectionRequest);
  }

  /** refreshObject de un subárbol (lectura; puebla valores en GenieACS). */
  refreshObject(deviceId: string, objectName: string, connectionRequest = true) {
    return this.pushTask(deviceId, { name: 'refreshObject', objectName }, connectionRequest);
  }

  // ---- Provisions / Presets (config del ACS) ----

  async putProvision(name: string, script: string): Promise<boolean> {
    const r = await this.req(`/provisions/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { ...this.headers(false), 'Content-Type': 'text/plain' },
      body: script,
    });
    return r.ok;
  }

  async putPreset(name: string, preset: Record<string, any>): Promise<boolean> {
    const r = await this.req(`/presets/${encodeURIComponent(name)}`, { method: 'PUT', headers: this.headers(), body: JSON.stringify(preset) });
    return r.ok;
  }

  async listPresets(): Promise<any[]> {
    const r = await this.req('/presets/', { headers: this.headers(false) });
    if (!r.ok) throw new NbiError(r.status, '/presets');
    return (await r.json()) as any[];
  }
}
