import { Client, ClientChannel } from 'ssh2';
import { Socket } from 'net';

/** Transporte mínimo que necesita la sesión: escribir y cerrar. */
type Canal = { write(data: string): void; end(): void };

export type OltTransporte = 'ssh' | 'telnet';

/**
 * OltDriver - Clase base para la conexión a OLTs.
 *
 * Portado de application/libraries/Olt/Olt_driver.php (legacy phpseclib3).
 * Maneja una sesión de CLI interactiva (write/read con detección de prompt y
 * paginación "---- More ----" / "{ <cr> }:") que reutilizan los drivers de cada
 * marca.
 *
 * DOS TRANSPORTES, una sola sesión. Por SSH se abre un canal `shell`; por TELNET
 * un socket TCP crudo con negociación IAC y login interactivo. De ahí para
 * arriba todo es idéntico: `sendCommand` escribe en `this.stream` y lee de
 * `this.buffer`, así que los 1.100 lineas de parseo del driver Huawei no saben
 * —ni les importa— por dónde viajan los comandos.
 *
 * Telnet no es un capricho heredado: bastantes OLT de planta traen el servidor
 * SSH deshabilitado de fábrica y solo escuchan en el 23.
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
  private socket: Socket | null = null;
  private stream: Canal | null = null;
  /** Buffer acumulado de datos recibidos aún no consumidos. */
  private buffer = '';
  /** La sesión murió (socket cerrado/error): no se puede reutilizar. */
  private dead = false;
  /** Esperas pendientes de readUntil: se despiertan al llegar datos. */
  private dataWaiters: Array<() => void> = [];

  protected transporte: OltTransporte;

  constructor(host: string, port: string | number, user: string, pass: string, transporte: OltTransporte = 'ssh') {
    this.host = (host || '').trim();
    this.transporte = transporte === 'telnet' ? 'telnet' : 'ssh';
    this.port = Number(port) || (this.transporte === 'telnet' ? 23 : 22);
    this.user = user;
    this.pass = pass;
  }

  getTransporte(): OltTransporte {
    return this.transporte;
  }

  /** Identificador de la marca/driver (para logs y UI). */
  abstract getMarca(): string;

  getError(): string {
    return this.error;
  }

  getRawLog(): string {
    return this.rawLog;
  }

  /**
   * Abre la sesión y autentica. Devuelve true si el login fue exitoso.
   * El transporte lo decide la ficha de la OLT.
   */
  connect(): Promise<boolean> {
    return this.transporte === 'telnet' ? this.connectTelnet() : this.connectSsh();
  }

  /** SSH: canal `shell` interactivo (los Huawei/ZTE usan CLI paginado, no exec). */
  private connectSsh(): Promise<boolean> {
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
            this.notifyData();
          });
          if (stream.stderr) {
            stream.stderr.on('data', (d: Buffer) => {
              this.buffer += d.toString('utf8');
              this.notifyData();
            });
          }
          stream.on('close', () => {
            this.stream = null;
            this.dead = true;
            this.notifyData();
          });
          done(true);
        });
      });
      client.on('error', (e: Error & { level?: string }) => {
        const msg = e.level === 'client-authentication'
          ? 'Autenticación fallida (usuario o password incorrectos).'
          : e.message;
        this.dead = true;
        this.notifyData();
        done(false, msg);
      });
      client.on('close', () => {
        this.dead = true;
        this.notifyData();
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

  /* ---- Telnet ---------------------------------------------------------- *
   *  Se implementa a pelo sobre `net.Socket` en vez de traer una librería:
   *  son ~60 líneas, no hay que auditar una dependencia más para hablar con
   *  equipos que están dentro de la red, y el login de estos CLI es siempre el
   *  mismo par de preguntas.
   * ---------------------------------------------------------------------- */

  /** Bytes del protocolo telnet (RFC 854). */
  private static readonly IAC = 255;
  private static readonly DONT = 254;
  private static readonly DO = 253;
  private static readonly WONT = 252;
  private static readonly WILL = 251;
  private static readonly SB = 250;
  private static readonly SE = 240;
  private static readonly OPT_ECHO = 1;
  private static readonly OPT_SGA = 3; // suppress go-ahead
  private static readonly OPT_TTYPE = 24;
  private static readonly OPT_NAWS = 31; // tamaño de ventana

  /**
   * Separa los mandos IAC del texto y los contesta.
   *
   * Sin esto los bytes de negociación entran al buffer y ensucian el parseo: un
   * 0xFF suelto en medio de una tabla de service-ports rompe la expresión que
   * lee las columnas.
   */
  private procesarTelnet(datos: Buffer): string {
    const D = OltDriver;
    let texto = '';
    const respuesta: number[] = [];
    for (let i = 0; i < datos.length; i++) {
      if (datos[i] !== D.IAC) { texto += String.fromCharCode(datos[i]); continue; }
      const mando = datos[++i];
      if (mando === D.IAC) { texto += String.fromCharCode(D.IAC); continue; } // 255 escapado
      if (mando === D.SB) {
        // Subnegociación: se contesta solo el tipo de terminal, el resto se salta.
        const opcion = datos[i + 1];
        while (i < datos.length && !(datos[i] === D.IAC && datos[i + 1] === D.SE)) i++;
        i++;
        if (opcion === D.OPT_TTYPE) {
          respuesta.push(D.IAC, D.SB, D.OPT_TTYPE, 0, ...[...'vt100'].map((c) => c.charCodeAt(0)), D.IAC, D.SE);
        }
        continue;
      }
      if (mando === D.DO || mando === D.DONT || mando === D.WILL || mando === D.WONT) {
        const opcion = datos[++i];
        if (mando === D.DO) {
          // Se aceptan las tres que hacen falta para una sesión de CLI usable.
          const acepto = opcion === D.OPT_TTYPE || opcion === D.OPT_NAWS || opcion === D.OPT_SGA;
          respuesta.push(D.IAC, acepto ? D.WILL : D.WONT, opcion);
          if (acepto && opcion === D.OPT_NAWS) {
            respuesta.push(D.IAC, D.SB, D.OPT_NAWS, 0, 200, 0, 200, D.IAC, D.SE);
          }
        } else if (mando === D.WILL) {
          const acepto = opcion === D.OPT_SGA || opcion === D.OPT_ECHO;
          respuesta.push(D.IAC, acepto ? D.DO : D.DONT, opcion);
        }
        // A DONT/WONT no se contesta: el otro extremo ya cerró esa opción.
      }
    }
    if (respuesta.length && this.socket) this.socket.write(Buffer.from(respuesta));
    return texto;
  }

  /**
   * Telnet: abre el socket, contesta la negociación y hace el login a mano
   * (usuario y contraseña son dos preguntas del propio equipo, no del protocolo).
   */
  private connectTelnet(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      this.socket = socket;
      let settled = false;
      const done = (ok: boolean, err?: string) => {
        if (settled) return;
        settled = true;
        if (!ok && err) this.error = this.humanizeError(err);
        resolve(ok);
      };

      socket.setTimeout(this.timeout);
      socket.on('data', (d: Buffer) => {
        const t = this.procesarTelnet(d);
        if (!t) return;
        this.buffer += t;
        this.rawLog += t;
        this.notifyData();
      });
      socket.on('error', (e: Error) => { this.dead = true; this.notifyData(); done(false, e.message); });
      socket.on('timeout', () => { this.dead = true; this.notifyData(); done(false, 'Connection timed out'); });
      socket.on('close', () => { this.stream = null; this.dead = true; this.notifyData(); });

      socket.connect(this.port, this.host, async () => {
        this.stream = { write: (d: string) => socket.write(d), end: () => socket.end() };
        try {
          // El equipo pregunta usuario y contraseña; los prompts varían de marca
          // ("Username:", "login:", ">>User name:"), de ahí que se busque flojo.
          const pideUsuario = await this.readUntil(/(user\s*name|username|login)\s*:\s*$/i, this.timeout);
          if (!/(user\s*name|username|login)\s*:\s*$/i.test(pideUsuario)) {
            done(false, 'El equipo no pidió usuario: ¿está escuchando telnet en ese puerto?');
            return;
          }
          this.stream.write(`${this.user}\n`);
          const pideClave = await this.readUntil(/password\s*:\s*$/i, this.timeout);
          if (!/password\s*:\s*$/i.test(pideClave)) { done(false, 'El equipo no pidió contraseña.'); return; }
          this.stream.write(`${this.pass}\n`);
          // Tras el login llega el prompt; si en su lugar repite la pregunta, la
          // credencial es mala (telnet no devuelve un error de autenticación
          // como SSH: reintenta y ya).
          const tras = await this.readUntil(/(?:^|[\r\n])[^\s\r\n]+[>#][ \t]*$|(user\s*name|username|login)\s*:\s*$/i, this.timeout);
          if (/(user\s*name|username|login)\s*:\s*$/i.test(tras)) {
            done(false, 'Autenticación fallida (usuario o password incorrectos).');
            return;
          }
          this.buffer = '';
          socket.setTimeout(0); // el timeout de conexión no debe matar la sesión ociosa
          done(true);
        } catch (e) {
          done(false, (e as Error).message);
        }
      });
    });
  }

  disconnect(): void {
    try {
      if (this.stream) this.stream.end();
    } catch { /* cerrando */ }
    try {
      if (this.client) this.client.end();
    } catch { /* cerrando */ }
    try {
      if (this.socket) this.socket.destroy();
    } catch { /* cerrando */ }
    this.stream = null;
    this.client = null;
    this.socket = null;
    this.dead = true;
    this.notifyData();
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
  /** VLAN(s) en uso por cada puerto PON, leídas de los service-ports. */
  async vlansPorPuerto(): Promise<PuertoConVlans[] | false> {
    this.error = `Leer las VLANs por puerto aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  /**
   * VLANs de la OLT y por qué puerto de red (uplink) sale cada una. Es la mitad
   * OLT de la salud de VLANs (`vlan-salud.ts`); los service-ports por PON van
   * aparte (`vlansPorPuerto`, que ya se cachea para el mapa).
   */
  async leerVlans(): Promise<{
    vlans: { vlan: number; tipo: string; atributo: string; estandar: number; servicePorts: number }[];
    puertosDeRed: { fsp: string; estado: string }[];
    vlansPorPuertoDeRed: Record<string, number[]>;
  } | false> {
    this.error = `Leer las VLANs aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  /** `display vlan N`: si existe y por qué puertos de red sale. */
  async detalleVlan(_vlan: number): Promise<{ vlan: number; existe: boolean; tipo: string | null; uplinks: { fsp: string; nativa: number; estado: string }[]; servicePorts: number } | false> {
    this.error = `Leer una VLAN aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  /** Crea la VLAN y/o la pone en el uplink. Solo lo que se pida; nunca borra. */
  async configurarVlan(_p: { vlan: number; crear: boolean; uplink: string | null }): Promise<{
    ok: boolean; respuestas: { cmd: string; out: string }[]; error?: string;
  } | false> {
    this.error = `Configurar VLANs aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  /** Tablas de tráfico (CIR/PIR): es donde se limita la velocidad del abonado. */
  async getTrafficTables(): Promise<{ id: string; cir: string; pir: string }[]> {
    return [];
  }
  /** Configuración de alta deducida de los abonados que ya cuelgan del puerto. */
  async sugerenciaDePuerto(
    _frame: number,
    _slot: number,
    _port: number,
    _opts?: { model?: string | null; vlanCatalogo?: number[] },
  ): Promise<any> {
    return { basadoEn: 0 };
  }
  async provisionOnu(_p: any): Promise<any | false> {
    this.error = `Aprovisionar ONU aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  /** Dónde está y cómo está una ONU ya autenticada, buscándola por SN. */
  async estadoPorSn(_sn: string): Promise<any | null> {
    this.error = `Localizar una ONU por SN aún no está implementado para ${this.getMarca()}.`;
    return null;
  }
  /** Deja con su comentario y velocidad una ONU que YA está autenticada. */
  async adoptarOnu(_p: any): Promise<any | false> {
    this.error = `Adoptar una ONU ya autenticada aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  /** Todos los service-ports de un puerto PON, con su ONT-ID y traffic-tables. */
  async servicePortsDePuerto(_frame: number, _slot: number, _port: number): Promise<any[]> {
    return [];
  }
  /** Cambia las traffic-tables del service-port de una ONU ya autenticada. */
  async setServicePortSpeed(_p: any): Promise<any | false> {
    this.error = `Cambiar la velocidad de una ONU aún no está implementado para ${this.getMarca()}.`;
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
  async setOnuDescription(_p: any): Promise<any | false> {
    this.error = `Cambiar el comentario de una ONU aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getOntDetail(_frame: number, _slot: number, _port: number, _ontid: number): Promise<any | false> {
    this.error = `Detalle de ONU aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getOntOptical(_frame: number, _slot: number, _port: number, _ontid: number): Promise<any | false> {
    this.error = `Óptica de ONU aún no está implementada para ${this.getMarca()}.`;
    return false;
  }
  async findBySn(_sn: string): Promise<any | false> {
    this.error = `Buscar por SN aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async getCatvPorts(_frame: number, _slot: number, _port: number, _ontid: number): Promise<any[] | false> {
    this.error = `Leer el puerto CATV aún no está implementado para ${this.getMarca()}.`;
    return false;
  }
  async setCatvState(_p: any): Promise<any | false> {
    this.error = `Cortar/activar CATV aún no está implementado para ${this.getMarca()}.`;
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

  /** Despierta todas las esperas pendientes de readUntil (llegaron datos o murió la sesión). */
  private notifyData(): void {
    const ws = this.dataWaiters;
    this.dataWaiters = [];
    for (const w of ws) w();
  }

  /** Espera hasta que lleguen datos nuevos o venza `ms` (lo que ocurra primero). */
  private waitData(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(fin, ms);
      this.dataWaiters.push(fin);
    });
  }

  /**
   * Lee del buffer hasta que aparezca `stopRegex` o venza `maxMs`. Consume del
   * buffer lo devuelto. Devuelve '' si no llegó nada nuevo antes del timeout.
   * La espera es por evento (data del canal), no por polling: la respuesta se
   * procesa apenas llega, importante con salidas paginadas de cientos de páginas.
   */
  private async readUntil(stopRegex: RegExp, maxMs: number): Promise<string> {
    const start = Date.now();
    while (true) {
      const m = this.buffer.match(stopRegex);
      if (m && m.index !== undefined) {
        const idx = m.index + m[0].length;
        const out = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx);
        return out;
      }
      const restante = maxMs - (Date.now() - start);
      if (restante <= 0 || this.dead) break;
      await this.waitData(Math.min(restante, 500));
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
   * El primer prompt puede tardar (banner + MOTD); los apilados llegan juntos,
   * así que tras el primero basta una ventana corta de silencio: antes se
   * esperaban 2 s completos de silencio y ese costo se pagaba en CADA sesión.
   */
  protected async drainBanner(): Promise<void> {
    await this.readUntil(this.promptRegex, 2500);
    for (let n = 0; n < 10; n++) {
      const out = await this.readUntil(this.promptRegex, 300);
      if (out === '') break;
    }
  }

  /** ¿La sesión sigue abierta y es reutilizable? */
  isAlive(): boolean {
    // Por telnet no hay `client` (eso es de ssh2): el vivo es el socket.
    const transporteVivo = this.transporte === 'telnet' ? !!this.socket : !!this.client;
    return transporteVivo && !!this.stream && !this.dead;
  }

  /**
   * Verifica que la sesión reutilizada responde: manda un ENTER y espera el
   * prompt. También limpia salida asíncrona acumulada (alarmas del equipo).
   */
  async probe(timeoutMs = 3000): Promise<boolean> {
    if (!this.isAlive()) return false;
    try {
      this.stream!.write('\n');
      const out = await this.readUntil(this.promptRegex, timeoutMs);
      return /[>#]/.test(out);
    } catch {
      return false;
    }
  }

  /** Limpia log y error entre usos de una sesión reutilizada (pool). */
  resetSession(): void {
    this.rawLog = '';
    this.error = '';
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
    // Descartar salida residual (alarmas asíncronas que el equipo imprime en la
    // VTY entre comandos): si se dejara, se colaría como respuesta del comando
    // que vamos a enviar. Ya quedó copiada en rawLog al llegar.
    if (this.buffer !== '') {
      this.rawLog += `\n[descartados ${this.buffer.length} car. residuales]\n`;
      this.buffer = '';
    }
    this.stream.write(cmd + '\n');
    this.rawLog += `\n>>> ${cmd}\n`;

    let buf = '';
    let loops = 0;
    // Ojo con `\{[^}]*\}:`: cubre TODOS los prompts de parámetro del CLI Huawei,
    // no solo los que ofrecen <cr>. Si solo se reconocen los de <cr>, un comando
    // incompleto deja la sesión esperando un valor y el SIGUIENTE comando se
    // escribe dentro de ese prompt (se come los espacios) → "Unknown command" y,
    // si se insiste, "Reenter times have reached the upper limit".
    const stop = /(?:\{[^}\r\n]{0,300}\}:)|(?:---- ?[Mm]ore)|(?:\(y\/n\))|(?:\[Y\/N\])|(?:(?:^|[\r\n])[^\s\r\n]+[>#][ \t]*$)/;

    // Guarda anti-reenter: si contestamos DOS veces seguidas al mismo prompt,
    // es que el equipo no acepta la respuesta automática. Insistir es lo que
    // dispara el "Reenter times have reached the upper limit" de Huawei (aborta
    // el comando al tercer intento) y, en el peor caso, cierra la sesión.
    let lastPrompt = '';
    let repeats = 0;
    const answer = (kind: string, chunkTail: string, write: string): boolean => {
      const sig = kind + '|' + chunkTail.slice(-120).replace(/\s+/g, ' ').trim();
      repeats = sig === lastPrompt ? repeats + 1 : 0;
      lastPrompt = sig;
      if (repeats >= 2) {
        this.error =
          'El equipo repitió la misma pregunta del CLI y no aceptó la respuesta automática. ' +
          'El comando se abortó para no bloquear la sesión.';
        this.rawLog += `\n[abortado: prompt repetido ${repeats + 1} veces]\n`;
        return false;
      }
      this.stream!.write(write);
      return true;
    };

    while (true) {
      if (++loops > maxLoops) break;
      const chunk = await this.readUntil(stop, this.timeout);
      if (chunk === '') break;
      buf += chunk;

      // El equipo ya agotó sus reintentos: no sirve seguir escribiendo.
      if (/Reenter times have reached the upper limit/i.test(chunk)) {
        this.error =
          'La OLT rechazó la respuesta automática a una pregunta del CLI y agotó los reintentos ' +
          '("Reenter times have reached the upper limit"). El comando no se aplicó.';
        break;
      }

      // Prompt de parámetro. Si ofrece <cr>, ENTER significa "ejecuta ya".
      if (/\{[^}\r\n]{0,300}\}:/.test(chunk)) {
        if (/<cr>/.test(chunk)) {
          if (!answer('cr', chunk, '\n')) break;
          continue;
        }
        // No ofrece <cr>: el comando está incompleto y el equipo espera un
        // valor que no sabemos inventar. Cancelamos con Ctrl+C para devolver
        // el CLI al prompt; si no, el próximo comando entra como respuesta.
        const pide = (chunk.match(/\{([^}\r\n]{0,300})\}:/) ?? [])[1] ?? '';
        this.error =
          `El comando "${cmd}" está incompleto: la OLT pide un parámetro más (${pide.trim()}).`;
        this.rawLog += `\n[cancelado con Ctrl+C: falta parámetro]\n`;
        this.stream.write('\x03');
        await this.readUntil(this.promptRegex, 3000);
        break;
      }
      if (/---- ?[Mm]ore/.test(chunk)) {
        // La paginación es legítima y se repite: no cuenta como reenter.
        lastPrompt = ''; repeats = 0;
        this.stream.write(' ');
        continue;
      }
      if (/\(y\/n\)|\[Y\/N\]/i.test(chunk)) {
        const yn = (autoConfirm ? 'y' : 'n') + '\n';
        if (!answer('yn', chunk, yn)) break;
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
    const s = String(v ?? '').replace(pattern, '');
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

/** Un puerto PON con las VLANs que usan sus service-ports (y cuántos cada una). */
export type PuertoConVlans = { frame: number; slot: number; port: number; servicios: number; vlans: { vlan: number; servicios: number }[] };
