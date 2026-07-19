import { Client, ClientChannel } from 'ssh2';

/**
 * OltDriver - Clase base para la conexión SSH a OLTs.
 *
 * Portado de application/libraries/Olt/Olt_driver.php (legacy phpseclib3).
 * Maneja la sesión SSH con la librería `ssh2` sobre un canal `shell`
 * interactivo (write/read con detección de prompt y paginación
 * "---- More ----" / "{ <cr> }:") que reutilizan los drivers de cada marca.
 *
 * Cada marca (Huawei, ZTE, ...) extiende esta clase y sobreescribe los
 * comandos/parsers específicos.
 */
export abstract class OltDriver {
  protected host: string;
  protected port: number;
  protected user: string;
  protected pass: string;

  /** Timeout de conexión y lectura por comando (ms). */
  public timeout = 12000;

  /** Último mensaje de error legible. */
  protected error = '';

  /** Log crudo de la sesión interactiva (para depurar/calibrar). */
  protected rawLog = '';

  /**
   * Regex que identifica el prompt del equipo (fin de un comando). El prompt
   * Huawei (ej. "MA5800-X7(config)#") está SIEMPRE al inicio de línea; los
   * datos vienen indentados. Anclamos a inicio de línea para no confundir
   * datos que terminan en ">" (p.ej. "<Gem Index 270>") con el prompt.
   */
  protected promptRegex = /(?:^|[\r\n])[^\s\r\n]+[>#][ \t]*$/;

  private client: Client | null = null;
  private stream: ClientChannel | null = null;
  /** Buffer acumulado de datos recibidos aún no consumidos. */
  private buffer = '';

  constructor(host: string, port: string | number, user: string, pass: string) {
    this.host = (host || '').trim();
    this.port = Number(port) || 22;
    this.user = user;
    this.pass = pass;
  }

  /** Identificador de la marca/driver (para logs y UI). */
  abstract getMarca(): string;

  getError(): string {
    return this.error;
  }

  getRawLog(): string {
    return this.rawLog;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Abre la sesión SSH, autentica y abre el canal shell interactivo.
   * Devuelve true si el login fue exitoso.
   */
  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      const client = new Client();
      this.client = client;
      let settled = false;
      const done = (ok: boolean, err?: string) => {
        if (settled) return;
        settled = true;
        if (!ok && err) this.error = this.humanizeError(err);
        resolve(ok);
      };

      client.on('ready', () => {
        // Canal shell interactivo (los Huawei/ZTE usan CLI paginado, no exec).
        client.shell({ term: 'vt100', rows: 200, cols: 200 }, (err, stream) => {
          if (err || !stream) {
            done(false, err ? err.message : 'No se pudo abrir el canal shell.');
            return;
          }
          this.stream = stream;
          stream.on('data', (d: Buffer) => {
            const s = d.toString('utf8');
            this.buffer += s;
            this.rawLog += s;
          });
          if (stream.stderr) {
            stream.stderr.on('data', (d: Buffer) => {
              this.buffer += d.toString('utf8');
            });
          }
          stream.on('close', () => {
            this.stream = null;
          });
          done(true);
        });
      });
      client.on('error', (e: Error & { level?: string }) => {
        const msg = e.level === 'client-authentication'
          ? 'Autenticación fallida (usuario o password incorrectos).'
          : e.message;
        done(false, msg);
      });
      client.on('timeout', () => done(false, 'Connection timed out'));

      try {
        client.connect({
          host: this.host,
          port: this.port,
          username: this.user,
          password: this.pass,
          readyTimeout: this.timeout,
          keepaliveInterval: 0,
          // Los OLT Huawei/ZTE suelen correr firmware SSH viejo: habilitar
          // explícitamente algoritmos legacy de KEX/cifrado/host-key.
          algorithms: {
            kex: [
              'diffie-hellman-group1-sha1',
              'diffie-hellman-group14-sha1',
              'diffie-hellman-group-exchange-sha1',
              'diffie-hellman-group14-sha256',
              'diffie-hellman-group-exchange-sha256',
              'ecdh-sha2-nistp256',
            ] as any,
            serverHostKey: ['ssh-rsa', 'ssh-dss', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256'] as any,
            cipher: [
              'aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc',
              'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
            ] as any,
            hmac: ['hmac-sha1', 'hmac-sha2-256', 'hmac-md5'] as any,
          },
        });
      } catch (e) {
        done(false, (e as Error).message);
      }
    });
  }

  disconnect(): void {
    try {
      if (this.stream) this.stream.end();
    } catch { /* cerrando */ }
    try {
      if (this.client) this.client.end();
    } catch { /* cerrando */ }
    this.stream = null;
    this.client = null;
  }

  /* ------------------------------------------------------------------ *
   *  Métodos de gestión de ONUs. Los implementa cada marca; en la base
   *  devuelven "no implementado" (false) como el legacy.
   * ------------------------------------------------------------------ */

  async prepare(): Promise<boolean> {
    return true;
  }
  async getBoards(_frame = 0): Promise<any[] | false> {
    this.error = `Listar tableros aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getOnus(_frame = 0, _slot: number | null = null, _port: number | null = null): Promise<any[] | false> {
    this.error = `Listar ONUs aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getAutofind(): Promise<any[] | false> {
    this.error = `Autofind aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getProfiles(): Promise<{ line: any[]; srv: any[] } | false> {
    this.error = `Listar perfiles aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async provisionOnu(_p: any): Promise<any | false> {
    this.error = `Aprovisionar ONU aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async rebootOnu(_p: any): Promise<any | false> {
    this.error = `Reiniciar ONU aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async deleteOnu(_p: any): Promise<any | false> {
    this.error = `Eliminar ONU aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getOntDetail(_frame: number, _slot: number, _port: number, _ontid: number): Promise<any | false> {
    this.error = `Detalle de ONU aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async findBySn(_sn: string): Promise<any | false> {
    this.error = `Buscar por SN aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getSystemInfo(): Promise<any> {
    return { model: '', version: '', patch: '', uptime: '' };
  }
  async getSlotSummary(_frame: number, _slot: number | null): Promise<any | false> {
    this.error = `Resumen de slot aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getSlotOnus(_frame: number, _slot: number | null): Promise<any[] | false> {
    this.error = `ONUs de slot aún no está implementado para ${this.getMarca()}.`;
    return false;
  }

  /* ------------------------------------------------------------------ *
   *  Capa de shell interactivo (reutilizable por los drivers).
   * ------------------------------------------------------------------ */

  /**
   * Lee del buffer hasta que aparezca `stopRegex` o venza `maxMs`. Consume del
   * buffer lo devuelto. Devuelve '' si no llegó nada nuevo antes del timeout.
   */
  private async readUntil(stopRegex: RegExp, maxMs: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const m = this.buffer.match(stopRegex);
      if (m && m.index !== undefined) {
        const idx = m.index + m[0].length;
        const out = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx);
        return out;
      }
      await this.sleep(30);
    }
    // Timeout: devolver lo pendiente (puede ser parcial) y vaciar.
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /**
   * Drena TODA la salida inicial (banner + prompts apilados) tras el login.
   * Equipos como el Huawei MA5800 dejan varios prompts en cola; si no se
   * vacían, cada comando lee la respuesta del anterior (desfase).
   */
  protected async drainBanner(): Promise<void> {
    for (let n = 0; n < 10; n++) {
      const out = await this.readUntil(this.promptRegex, 2000);
      if (out === '') break;
    }
  }

  /**
   * Envía un comando y devuelve la salida hasta el prompt, manejando:
   *   - paginación "---- More ----"       (envía espacio)
   *   - paginación Huawei "{ <cr> }:"      (envía ENTER)
   *   - confirmaciones "(y/n)" / "[Y/N]"   (ver autoConfirm)
   *
   * @param autoConfirm true → responde "y" (escritura); false → "n" (lectura).
   */
  protected async sendCommand(cmd: string, autoConfirm = false, maxLoops = 200): Promise<string> {
    if (!this.stream) return '';
    this.stream.write(cmd + '\n');
    this.rawLog += `\n>>> ${cmd}\n`;

    let buf = '';
    let loops = 0;
    const stop = /(?:\{ <cr>[^}]*\}:)|(?:---- ?[Mm]ore)|(?:\(y\/n\))|(?:\[Y\/N\])|(?:(?:^|[\r\n])[^\s\r\n]+[>#][ \t]*$)/;

    while (true) {
      if (++loops > maxLoops) break;
      const chunk = await this.readUntil(stop, this.timeout);
      if (chunk === '') break;
      buf += chunk;

      if (/\{ <cr>[^}]*\}:/.test(chunk)) {
        this.stream.write('\n');
        continue;
      }
      if (/---- ?[Mm]ore/.test(chunk)) {
        this.stream.write(' ');
        continue;
      }
      if (/\(y\/n\)|\[Y\/N\]/i.test(chunk)) {
        this.stream.write((autoConfirm ? 'y' : 'n') + '\n');
        this.rawLog += (autoConfirm ? '[auto y]' : '[auto n]') + '\n';
        continue;
      }
      // Llegamos al prompt: fin del comando.
      break;
    }

    return this.cleanOutput(buf, cmd);
  }

  /**
   * Sanea un valor para usarlo dentro de un comando CLI: elimina caracteres
   * fuera del rango imprimible (o los que pida $pattern) y los peligrosos
   * ("`;) que permitirían inyectar comandos.
   */
  protected sanitize(v: unknown, pattern = /[^\x20-\x7E]/g): string {
    let s = String(v ?? '').replace(pattern, '');
    return s.replace(/["`;]/g, '');
  }

  /**
   * Limpia la salida cruda: quita el eco del comando, los indicadores de
   * paginación y la línea del prompt final.
   */
  protected cleanOutput(raw: string, cmd: string): string {
    raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Quitar secuencias de escape ANSI/CSI (el paginador emite ESC[37D para
    // reposicionar el cursor; si no se quitan, se cuelan como "[37D" en los valores).
    raw = raw.replace(/\x1b\[[0-9;?=]*[ -/]*[@-~]/g, '');
    raw = raw.replace(/\x1b./g, '');
    // Quitar indicadores de paginación (con relleno de backspaces/espacios). El
    // "More" reposiciona el cursor y refloja la línea siguiente pegándola a la
    // anterior, así que lo reemplazamos por un SALTO DE LÍNEA (no por '') para no
    // fundir dos campos (ej. "Ont EquipmentID" con "Ont Customized Info").
    raw = raw.replace(/[ \t]*-+ ?[Mm]ore ?\([^)]*\) ?-+[\x08 ]*/g, '\n');
    raw = raw.replace(/[ \t]*-+ ?[Mm]ore ?-+[\x08 ]*/g, '\n');
    raw = raw.replace(/\{ <cr>[^}]*\}:\s*/g, '');
    raw = raw.replace(/[\x08]+/g, '');

    let lines = raw.split('\n');
    // Quitar el eco "Command:" del MA5800.
    lines = lines.filter((l) => l.trim() !== 'Command:');
    // Quitar la primera línea si es el eco del comando.
    if (lines.length && lines[0].trim().includes(cmd.trim())) {
      lines.shift();
    }
    // Quitar la última línea si es el prompt.
    const last = lines.length - 1;
    if (last >= 0 && /^[^\s]+[>#][ \t]*$/.test(lines[last])) {
      lines.pop();
    }
    return lines.join('\n').trim();
  }

  /** Traduce mensajes técnicos de ssh2 a algo entendible en la UI. */
  protected humanizeError(msg: string): string {
    msg = String(msg || '');
    if (/timed out|timeout|ETIMEDOUT/i.test(msg)) {
      return 'No hubo respuesta del equipo (timeout). Verifique IP/puerto y que SSH esté habilitado.';
    }
    if (/ECONNREFUSED|Connection refused/i.test(msg)) {
      return 'Conexión rechazada. El puerto SSH no está abierto o es incorrecto.';
    }
    if (/getaddrinfo|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|Unable to connect/i.test(msg)) {
      return 'No se pudo alcanzar el host. Verifique la IP/DNS y la ruta de red.';
    }
    if (/authentication|All configured authentication methods failed/i.test(msg)) {
      return 'Autenticación fallida (usuario o password incorrectos).';
    }
    if (/handshake|no matching|key exchange|cipher/i.test(msg)) {
      return 'Fallo de negociación SSH (algoritmos incompatibles con el equipo).';
    }
    return msg;
  }
}
