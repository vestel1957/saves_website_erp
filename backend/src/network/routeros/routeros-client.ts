/**
 * Cliente RouterOS API en Node puro (sin dependencias externas).
 *
 * Porta la lógica de `application/libraries/RouterosAPI.php` del legacy saves-vestel:
 * protocolo binario de la API de MikroTik (word = length-prefix + bytes, sentence
 * termina en word de longitud 0), con login pre- y post-v6.43.
 *
 * Se comunica por el puerto de API (no SSL): Vestel usa puertos custom (5050/5051).
 *
 * Uso:
 *   const api = new RouterosClient();
 *   await api.connect('181.118.150.29', 5051, 'api.crmvestel', 'secret', { timeoutMs: 5000 });
 *   const rows = await api.comm('/ppp/secret/print', { '?name': 'juanperez' });
 *   api.close();
 */
import { createConnection, Socket } from 'net';
import { createHash } from 'crypto';

export type RosRow = Record<string, string>;

export class RouterosError extends Error {
  constructor(
    message: string,
    readonly code: 'CONNECT' | 'LOGIN' | 'TRAP' | 'TIMEOUT' | 'SOCKET' = 'SOCKET',
  ) {
    super(message);
    this.name = 'RouterosError';
  }
}

export class RouterosClient {
  private socket: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  /** Cola de resolvers esperando el próximo "word" completo. */
  private wordWaiters: Array<(w: string | null) => void> = [];
  /** Words ya parseados y en cola (por si llegan antes de que alguien los pida). */
  private wordQueue: string[] = [];
  private fatalError: Error | null = null;
  private connected = false;
  /**
   * Cola de comandos. La API de RouterOS sobre un socket NO multiplexa: las
   * respuestas llegan sin etiqueta, en el orden en que se pidieron. Dos comm()
   * en vuelo a la vez se roban las palabras del otro y ambos acaban en timeout
   * (así se veían "0 morosos" en el resumen del router: un Promise.all de 4
   * lecturas que se pisaban entre sí). Se serializan aquí, no en cada llamador.
   */
  private queue: Promise<unknown> = Promise.resolve();

  // ---- codificación de longitud (idéntica a encodeLength de PHP) ----
  private encodeLength(length: number): Buffer {
    if (length < 0x80) {
      return Buffer.from([length]);
    } else if (length < 0x4000) {
      const l = length | 0x8000;
      return Buffer.from([(l >> 8) & 0xff, l & 0xff]);
    } else if (length < 0x200000) {
      const l = length | 0xc00000;
      return Buffer.from([(l >> 16) & 0xff, (l >> 8) & 0xff, l & 0xff]);
    } else if (length < 0x10000000) {
      const l = length | 0xe0000000;
      return Buffer.from([(l >> 24) & 0xff, (l >> 16) & 0xff, (l >> 8) & 0xff, l & 0xff]);
    } else {
      return Buffer.from([
        0xf0,
        (length >> 24) & 0xff,
        (length >> 16) & 0xff,
        (length >> 8) & 0xff,
        length & 0xff,
      ]);
    }
  }

  /**
   * Intenta decodificar una longitud desde `buf` en `offset`.
   * Devuelve [length, bytesConsumidos] o null si aún no hay suficientes bytes.
   */
  private decodeLength(buf: Buffer, offset: number): [number, number] | null {
    if (offset >= buf.length) return null;
    const b0 = buf[offset];
    if ((b0 & 0x80) === 0x00) {
      return [b0, 1];
    } else if ((b0 & 0xc0) === 0x80) {
      if (offset + 1 >= buf.length) return null;
      return [((b0 & ~0xc0) << 8) + buf[offset + 1], 2];
    } else if ((b0 & 0xe0) === 0xc0) {
      if (offset + 2 >= buf.length) return null;
      return [((b0 & ~0xe0) << 16) + (buf[offset + 1] << 8) + buf[offset + 2], 3];
    } else if ((b0 & 0xf0) === 0xe0) {
      if (offset + 3 >= buf.length) return null;
      return [
        ((b0 & ~0xf0) << 24) +
          (buf[offset + 1] << 16) +
          (buf[offset + 2] << 8) +
          buf[offset + 3],
        4,
      ];
    } else if ((b0 & 0xf8) === 0xf0) {
      if (offset + 4 >= buf.length) return null;
      return [
        buf[offset + 1] * 0x1000000 +
          (buf[offset + 2] << 16) +
          (buf[offset + 3] << 8) +
          buf[offset + 4],
        5,
      ];
    }
    return [b0, 1];
  }

  /** Procesa el buffer acumulado extrayendo todos los words completos. */
  private drainBuffer() {
    while (true) {
      const decoded = this.decodeLength(this.buf, 0);
      if (!decoded) break;
      const [len, headerBytes] = decoded;
      if (this.buf.length < headerBytes + len) break; // word incompleto
      const word = this.buf.slice(headerBytes, headerBytes + len).toString('utf8');
      this.buf = this.buf.slice(headerBytes + len);
      this.pushWord(word);
    }
  }

  private pushWord(word: string) {
    const waiter = this.wordWaiters.shift();
    if (waiter) waiter(word);
    else this.wordQueue.push(word);
  }

  /** Espera el próximo word (string; '' = fin de sentence). */
  private nextWord(timeoutMs: number): Promise<string> {
    if (this.wordQueue.length) return Promise.resolve(this.wordQueue.shift() as string);
    if (this.fatalError) return Promise.reject(this.fatalError);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // quitar este waiter
        const idx = this.wordWaiters.indexOf(wrapped);
        if (idx >= 0) this.wordWaiters.splice(idx, 1);
        reject(new RouterosError('Timeout esperando respuesta del router', 'TIMEOUT'));
      }, timeoutMs);
      const wrapped = (w: string | null) => {
        clearTimeout(timer);
        if (w === null) reject(this.fatalError ?? new RouterosError('Socket cerrado', 'SOCKET'));
        else resolve(w);
      };
      this.wordWaiters.push(wrapped);
    });
  }

  /** Escribe una sentence (array de words) terminada en word vacío. */
  private writeSentence(words: string[]) {
    if (!this.socket) throw new RouterosError('No conectado', 'SOCKET');
    const chunks: Buffer[] = [];
    for (const w of words) {
      const wb = Buffer.from(w, 'utf8');
      chunks.push(this.encodeLength(wb.length), wb);
    }
    chunks.push(Buffer.from([0x00])); // fin de sentence
    this.socket.write(Buffer.concat(chunks));
  }

  /** Lee una sentence completa (words hasta el word vacío). */
  private async readSentence(timeoutMs: number): Promise<string[]> {
    const words: string[] = [];
    while (true) {
      const w = await this.nextWord(timeoutMs);
      if (w === '') break;
      words.push(w);
    }
    return words;
  }

  /**
   * Lee una respuesta completa: sentences hasta `!done` o `!fatal`.
   * Devuelve las filas `!re` como mapas clave→valor. Lanza en `!trap`/`!fatal`.
   */
  private async readReply(timeoutMs: number): Promise<RosRow[]> {
    const rows: RosRow[] = [];
    let trap: string | null = null;
    while (true) {
      const sentence = await this.readSentence(timeoutMs);
      if (sentence.length === 0) continue;
      const type = sentence[0];
      const attrs: RosRow = {};
      for (let i = 1; i < sentence.length; i++) {
        const word = sentence[i];
        if (word.startsWith('=')) {
          const eq = word.indexOf('=', 1);
          if (eq > 0) attrs[word.slice(1, eq)] = word.slice(eq + 1);
          else attrs[word.slice(1)] = '';
        } else if (word.startsWith('!')) {
          // pares tipo !re embebidos, ignorar
        }
      }
      if (type === '!re') {
        rows.push(attrs);
      } else if (type === '!trap' || type === '!fatal') {
        trap = attrs['message'] || sentence.join(' ');
      } else if (type === '!done') {
        if (attrs['ret'] !== undefined) rows.push(attrs);
        break;
      }
    }
    if (trap) throw new RouterosError(trap, 'TRAP');
    return rows;
  }

  /** Conecta y hace login (soporta pre- y post-v6.43). */
  async connect(
    host: string,
    port: number,
    login: string,
    password: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 8000;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port });
      const onError = (err: Error) =>
        reject(new RouterosError(`No se pudo conectar a ${host}:${port} — ${err.message}`, 'CONNECT'));
      const connTimer = setTimeout(() => {
        socket.destroy();
        reject(new RouterosError(`Timeout conectando a ${host}:${port}`, 'TIMEOUT'));
      }, timeoutMs);
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(connTimer);
        socket.removeListener('error', onError);
        socket.setNoDelay(true);
        this.socket = socket;
        socket.on('data', (data: Buffer) => {
          this.buf = Buffer.concat([this.buf, data]);
          this.drainBuffer();
        });
        socket.on('error', (err) => {
          this.fatalError = new RouterosError(`Error de socket: ${err.message}`, 'SOCKET');
          this.flushWaiters();
        });
        socket.on('close', () => {
          if (!this.fatalError) this.fatalError = new RouterosError('Conexión cerrada', 'SOCKET');
          this.flushWaiters();
        });
        resolve();
      });
    });

    // --- login post-v6.43 (plaintext) ---
    this.writeSentence(['/login', `=name=${login}`, `=password=${password}`]);
    const reply = await this.readSentenceLogin(timeoutMs);

    if (reply.done && reply.ret === undefined) {
      this.connected = true; // método nuevo
      return;
    }
    // --- login pre-v6.43 (challenge/response) ---
    if (reply.ret && /^[0-9a-fA-F]{32}$/.test(reply.ret)) {
      const challenge = Buffer.from(reply.ret, 'hex');
      const md5 = createHash('md5')
        .update(Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), challenge]))
        .digest('hex');
      this.writeSentence(['/login', `=name=${login}`, `=response=00${md5}`]);
      const r2 = await this.readReplySafe(timeoutMs);
      if (r2.ok) {
        this.connected = true;
        return;
      }
      throw new RouterosError('Login rechazado (credenciales inválidas)', 'LOGIN');
    }
    throw new RouterosError('Login rechazado por el router', 'LOGIN');
  }

  /** Lee la respuesta del primer /login capturando ret y done. */
  private async readSentenceLogin(
    timeoutMs: number,
  ): Promise<{ done: boolean; ret?: string }> {
    let done = false;
    let ret: string | undefined;
    while (true) {
      const sentence = await this.readSentence(timeoutMs);
      if (sentence.length === 0) continue;
      const type = sentence[0];
      for (let i = 1; i < sentence.length; i++) {
        const w = sentence[i];
        if (w.startsWith('=ret=')) ret = w.slice(5);
      }
      if (type === '!done') {
        done = true;
        break;
      }
      if (type === '!trap' || type === '!fatal') {
        throw new RouterosError('Login rechazado por el router', 'LOGIN');
      }
    }
    return { done, ret };
  }

  private async readReplySafe(timeoutMs: number): Promise<{ ok: boolean }> {
    try {
      await this.readReply(timeoutMs);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  private flushWaiters() {
    while (this.wordWaiters.length) {
      const w = this.wordWaiters.shift();
      if (w) w(null);
    }
  }

  /**
   * Ejecuta un comando. Igual que `comm()` del RouterosAPI.php original:
   *   - clave `?xxx`  → query:      `?xxx=value`
   *   - clave `~xxx`  → regex query: `~xxx~value`
   *   - cualquier otra (incluye `.id`, `.proplist`) → atributo: `=clave=value`
   */
  async comm(command: string, params: Record<string, string> = {}, timeoutMs = 8000): Promise<RosRow[]> {
    // Encadena: cada comando espera a que el anterior termine (bien o mal).
    const run = this.queue.then(
      () => this.commNow(command, params, timeoutMs),
      () => this.commNow(command, params, timeoutMs),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commNow(command: string, params: Record<string, string>, timeoutMs: number): Promise<RosRow[]> {
    if (!this.socket) throw new RouterosError('No conectado', 'SOCKET');
    const words: string[] = [command];
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('?')) {
        words.push(`${k}=${v}`);
      } else if (k.startsWith('~')) {
        words.push(`${k}~${v}`);
      } else {
        words.push(`=${k}=${v}`);
      }
    }
    this.writeSentence(words);
    try {
      return await this.readReply(timeoutMs);
    } catch (e) {
      // Un timeout deja a medias la respuesta del router: las palabras que
      // lleguen tarde contaminarían el SIGUIENTE comando (devolvería datos de
      // otro). La conexión queda inservible: se cierra en vez de mentir.
      if (e instanceof RouterosError && e.code === 'TIMEOUT') {
        this.fatalError = e;
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;
        this.wordQueue = [];
        this.buf = Buffer.alloc(0);
        this.flushWaiters();
      }
      throw e;
    }
  }

  get isConnected(): boolean {
    return this.connected && !!this.socket && !this.socket.destroyed;
  }

  close() {
    try {
      if (this.socket && !this.socket.destroyed) {
        try {
          this.writeSentence(['/quit']);
        } catch {
          /* ignore */
        }
        this.socket.end();
        this.socket.destroy();
      }
    } catch {
      /* ignore */
    } finally {
      this.socket = null;
      this.connected = false;
      this.flushWaiters();
    }
  }
}
