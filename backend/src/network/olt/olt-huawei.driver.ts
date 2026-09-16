import { OltDriver } from './olt-ssh.client';

/**
 * OltHuawei - Driver para OLTs Huawei (MA5608T / MA5680T / MA5800...).
 * Portado 1:1 de application/libraries/Olt/Olt_huawei.php (mismas regex).
 *
 * Los parsers se basan en el formato CLI estándar de la familia MA5600T/5800.
 * La salida varía entre firmwares; por eso cada método deja la salida cruda
 * disponible (getRawLog()) para ajustar las regex con un equipo real.
 */
export class OltHuawei extends OltDriver {
  /** Aviso no fatal del último alta (p.ej. service-port omitido). */
  private avisoAlta = '';

  getMarca(): string {
    return 'Huawei';
  }

  /** Entra a modo enable + config. La paginación la maneja sendCommand(). */
  async prepare(): Promise<boolean> {
    try {
      await this.drainBanner();
      await this.sendCommand('enable');
      await this.sendCommand('config');
      return true;
    } catch (e) {
      this.error = 'No se pudo preparar la sesión Huawei: ' + (e as Error).message;
      return false;
    }
  }

  /** display board <frame>  ->  [ {slot, board, status, gpon, epon}, ... ] */
  async getBoards(frame = 0): Promise<any[]> {
    const out = await this.sendCommand('display board ' + Number(frame || 0));
    const boards: any[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)/);
      if (m) {
        boards.push({
          slot: m[1],
          board: m[2],
          status: m[3],
          gpon: /GP|GICF|GPFD|GPBD|GPHF/i.test(m[2]),
          epon: /EP|EPBD|EPFD/i.test(m[2]),
        });
      }
    }
    return boards;
  }

  /** Info del sistema (modelo/version/parche/uptime). Best-effort. */
  async getSystemInfo(): Promise<any> {
    const ver = await this.sendCommand('display version');
    const info: any = { model: '', version: '', patch: '', uptime: '' };
    let m: RegExpMatchArray | null;
    if ((m = ver.match(/\b(MA\d{4}[A-Z0-9-]*)/i))) info.model = m[1];
    if ((m = ver.match(/VERSION[^\n:]*:\s*([^\r\n]+)/i))) info.version = m[1].trim();
    if ((m = ver.match(/PATCH[^\n:]*:\s*([^\r\n]+)/i))) info.patch = m[1].trim();
    if ((m = ver.match(/uptime\s+is\s+([^\r\n]+)/i))) {
      info.uptime = m[1].trim();
    } else {
      const up = await this.sendCommand('display sysuptime');
      if ((m = up.match(/uptime\s+is\s+([^\r\n]+)/i))) info.uptime = m[1].trim();
      else if ((m = up.match(/:\s*([0-9][^\r\n]*(?:day|hour|min|seg|dia)[^\r\n]*)/i))) info.uptime = m[1].trim();
    }
    return info;
  }

  /**
   * Resumen de ONUs de un slot: recorre puertos 0..15 y cuenta online/offline.
   * @return {slot,total,online,offline,ports:[{port,total,online,offline}]}
   */
  async getSlotSummary(frame = 0, slot: number | null = null): Promise<any | false> {
    if (slot === null) { this.error = 'Debe indicar slot.'; return false; }
    const f = Number(frame) || 0;
    const s = Number(slot);
    const res: any = { slot: s, total: 0, online: 0, offline: 0, ports: [] };
    for (let p = 0; p <= 15; p++) {
      const out = await this.sendCommand(`display ont info ${f} ${s} ${p} all`);
      const rows = this.parseOntInfo(out);
      if (!rows.length) continue;
      let on = 0, off = 0;
      for (const r of rows) {
        if (/online/i.test(r.run_state)) on++; else off++;
      }
      res.ports.push({ port: p, total: rows.length, online: on, offline: off });
      res.total += rows.length; res.online += on; res.offline += off;
    }
    return res;
  }

  /** TODAS las ONUs de un slot (puertos 0..15) para inventario/sync. */
  async getSlotOnus(frame = 0, slot: number | null = null): Promise<any[] | false> {
    if (slot === null) { this.error = 'Debe indicar slot.'; return false; }
    const f = Number(frame) || 0;
    const s = Number(slot);
    const todas: any[] = [];
    for (let p = 0; p <= 15; p++) {
      const onus = await this.getOnus(f, s, p);
      if (onus === false || !onus.length) continue;
      for (const o of onus) {
        o.frame = f; o.slot = s; o.port = p;
        todas.push(o);
      }
    }
    return todas;
  }

  /**
   * Lista ONUs de un puerto: display ont info + display ont optical-info.
   * @return [ {fsp, ont_id, sn, run_state, config_state, match_state, rx_power}, ... ]
   */
  async getOnus(frame = 0, slot: number | null = null, port: number | null = null): Promise<any[] | false> {
    if (slot === null || port === null) { this.error = 'Debe indicar slot y puerto.'; return false; }
    const f = Number(frame) || 0, s = Number(slot), p = Number(port);

    const info = await this.sendCommand(`display ont info ${f} ${s} ${p} all`);
    const onus = this.parseOntInfo(info);

    // Potencia óptica (best-effort). En el MA5800 va dentro de interface gpon.
    await this.sendCommand(`interface gpon ${f}/${s}`);
    const optical = await this.sendCommand(`display ont optical-info ${p} all`);
    await this.sendCommand('quit');
    const rx = this.parseOptical(optical);
    for (const o of onus) {
      o.rx_power = rx[o.ont_id] !== undefined ? rx[o.ont_id] : '';
    }
    return onus;
  }

  /** display ont autofind all -> ONUs detectadas sin aprovisionar. */
  async getAutofind(): Promise<any[]> {
    const out = await this.sendCommand('display ont autofind all');
    const found: any[] = [];
    const blocks = out.split(/(?=^\s*Number\s*:)/m);
    for (const b of blocks) {
      if (!/F\/S\/P/i.test(b) && !/SN/i.test(b)) continue;
      const fsp = this.kv(b, 'F\\/S\\/P');
      const sn = this.kv(b, 'Ont SN|SN');
      if (fsp === '' && sn === '') continue;
      found.push({
        fsp,
        sn: sn.replace(/\s*\(.*$/, ''),
        sn_full: sn,
        password: this.kv(b, 'Password'),
        loid: this.kv(b, 'Loid'),
        // Datos extra que la OLT expone por ONU no autorizada. `kv()` ya convierte
        // "-" en '' (no todos los modelos los reportan: los xPON genéricos suelen
        // traer MAC vacía; los ONT Huawei sí la reportan).
        mac: this.kv(b, 'Ont MAC'),
        model: this.kv(b, 'Ont EquipmentID'),
        vendor: this.kv(b, 'VendorID'),
        version: this.kv(b, 'Ont Version'),
        /**
         * Desde cuándo se está anunciando (`2026-08-19 14:28:46-05:00`).
         *
         * Es el dato que distingue la ONU que el técnico acaba de conectar del
         * resto: el autofind de esta planta arrastra decenas de equipos que
         * llevan semanas sonando (66 en VILLANUEVA, el más viejo de hace 15
         * días). Se normaliza a ISO —cambiar el espacio por la T— porque el
         * formato de la OLT no lo parsea `Date` de forma fiable.
         */
        autofind_time: this.kv(b, 'Ont autofind time').replace(' ', 'T') || null,
      });
    }
    return found;
  }

  /** Perfiles GPON disponibles: line-profile y srv-profile. */
  async getProfiles(): Promise<{ line: any[]; srv: any[] }> {
    const line = this.parseProfiles(await this.sendCommand('display ont-lineprofile gpon all'));
    const srv = this.parseProfiles(await this.sendCommand('display ont-srvprofile gpon all'));
    return { line, srv };
  }

  /**
   * Aprovisiona (autoriza) una ONU por SN en Huawei GPON.
   *   interface gpon <frame>/<slot>
   *     ont add <port> [<ontid>] sn-auth "<SN>" omci
   *         ont-lineprofile-id <lp> ont-srvprofile-id <sp> [desc "<desc>"]
   *   quit
   *   (opcional) service-port ... gpon F/S/P ont <ontid> gemport <gem> ...
   */
  async provisionOnu(p: any): Promise<any | false> {
    // Las sesiones SSH se reutilizan entre altas: sin limpiar, el aviso de la
    // anterior se colaría en la verificación de esta.
    this.avisoAlta = '';
    const frame = Number(p.frame ?? 0) || 0;
    const slot = p.slot !== undefined && p.slot !== null && p.slot !== '' ? Number(p.slot) : null;
    const port = p.port !== undefined && p.port !== null && p.port !== '' ? Number(p.port) : null;
    const sn = this.sanitize(p.sn ?? '', /[^A-Za-z0-9]/g);

    if (slot === null || port === null) { this.error = 'Debe indicar slot y puerto.'; return false; }
    if (sn === '') { this.error = 'SN inválido o vacío.'; return false; }
    if (!p.lineprofile || !p.srvprofile) { this.error = 'Debe indicar line-profile y srv-profile.'; return false; }

    const commands: string[] = [];
    /**
     * Lo que contestó la OLT a cada comando de ESCRITURA. La transcripción SSH
     * completa se recorta por la cola al registrarla, y en un alta la cola es el
     * listado de service-ports del puerto: justo lo que sobra. Sin esto, un alta
     * que falla a medias se investiga a ciegas (pasó: "0 service-port(s)" sin
     * ninguna pista de por qué).
     */
    const respuestas: { cmd: string; out: string }[] = [];
    /** Correcciones aplicadas al vuelo (p.ej. el GEM-port real de la ONT). */
    const avisosSp: string[] = [];

    // 1) Entrar a la interfaz GPON del slot.
    await this.sendCommand(`interface gpon ${frame}/${slot}`);
    commands.push(`interface gpon ${frame}/${slot}`);

    // 2) ont add. ONT-ID explícito o auto-asignado por la OLT.
    const ontidStr = p.ont_id !== undefined && p.ont_id !== '' && p.ont_id !== null ? ' ' + Number(p.ont_id) : '';
    let cmd = `ont add ${port}${ontidStr} sn-auth "${sn}" omci`
      + ` ont-lineprofile-id ${Number(p.lineprofile)}`
      + ` ont-srvprofile-id ${Number(p.srvprofile)}`;
    if (p.desc) cmd += ` desc "${this.sanitize(p.desc)}"`;
    const out = await this.sendCommand(cmd, true);
    commands.push(cmd);
    respuestas.push({ cmd, out: this.resumenDeSalida(out) });

    // "SN already exists": la ONU YA está dada de alta en algún puerto de esta
    // OLT (autenticada antes desde aquí, desde SmartOLT o a mano). No es un
    // fallo de perfil ni de velocidad, y devolverlo como error genérico hace
    // que se reintente cambiando el srv-profile —cosa que nunca va a funcionar—
    // en vez de mirar dónde está. Se busca y se devuelve con su posición.
    if (/already exist|repeat|sn.*(?:in use|used by)/i.test(out)) {
      await this.sendCommand('quit');
      const existente = await this.estadoPorSn(sn);
      this.error = existente
        ? `Esta ONU ya está autenticada en la OLT, en ${existente.fsp} (ONT-ID ${existente.ont_id}).`
        : 'La OLT dice que ese SN ya existe, pero no se pudo localizar en qué puerto está.';
      return { ok: false, codigo: 'SN_YA_EXISTE', error: this.error, existente };
    }
    if (/failure|fail|invalid|incorrect|conflict/i.test(out)) {
      await this.sendCommand('quit');
      this.error = this.mensajeDeFallo(out, 'el alta');
      return false;
    }

    // ONT-ID resultante (si fue auto-asignado, intentar parsearlo).
    let ontId = p.ont_id !== undefined && p.ont_id !== '' && p.ont_id !== null ? String(Number(p.ont_id)) : '';
    let m: RegExpMatchArray | null;
    if (ontId === '' && (m = out.match(/ONT\s*ID\s*[:=]\s*(\d+)/i))) ontId = m[1];

    // 3) Salir de la interfaz.
    await this.sendCommand('quit');
    commands.push('quit');

    // 4) service-port: sin él la ONT queda registrada pero SIN servicio. Se
    //    omite solo si no se dieron VLAN/gemport, y en ese caso hay que decirlo:
    //    antes se saltaba en silencio y el alta parecía correcta.
    const faltaSp = !p.vlan || p.gemport === '' || p.gemport === null || p.gemport === undefined;
    if (faltaSp) {
      this.avisoAlta = 'No se creó el service-port porque falta VLAN o GEM-port: '
        + 'la ONU queda registrada en la OLT pero sin servicio ni velocidad.';
    }
    if (!faltaSp && ontId !== '') {
      const r = await this.crearServicePort({
        frame, slot, port, ontId: Number(ontId),
        vlan: Number(p.vlan), gemport: Number(p.gemport),
        user_vlan: p.user_vlan ? Number(p.user_vlan) : Number(p.vlan),
        tag_transform: p.tag_transform, traffic_in: p.traffic_in, traffic_out: p.traffic_out,
      });
      commands.push(r.cmd);
      respuestas.push({ cmd: r.cmd, out: r.salida });
      if (r.avisoGem) avisosSp.push(r.avisoGem);
      if (!r.ok) {
        // El motivo lo dice la OLT en una línea y antes se tiraba: quedaba un
        // "0 service-port(s)" sin causa, que es lo mismo que no decir nada.
        // No se devuelve false —la ONT sí quedó creada— pero el aviso viaja
        // hasta la pantalla del técnico.
        this.avisoAlta = 'La ONT se agregó pero el SERVICE-PORT no: ' + r.error
          + ' La ONU queda registrada sin servicio ni velocidad.';
        this.error = this.avisoAlta;
      } else if (avisosSp.length) {
        this.avisoAlta = avisosSp.join(' ');
      }
    }

    // Releer la ONT: que el comando no diera error NO significa que el abonado
    // tenga servicio. Huawei acepta el `ont add` y luego marca la config como
    // fallida si el srv-profile no cuadra con el equipo real (match: mismatch).
    let verificacion: any = null;
    if (ontId !== '') {
      verificacion = await this.verificarAlta(frame, slot, port, Number(ontId));
    }

    return {
      ok: true,
      message: 'ONT agregada' + (ontId !== '' ? ` (ONT-ID ${ontId})` : '') + '.',
      ont_id: ontId,
      commands,
      respuestas,
      verificacion,
    };
  }

  /**
   * Crea el service-port de una ONT — el paso que le da servicio de verdad.
   *
   * El GEM-port NO se elige: es el que trae el line-profile con el que se dio de
   * alta la ONT, y pedir otro hace que la OLT rechace el comando entero. Pasó en
   * vivo (YOPAL 0/1/4, ONT 28): se mandó `gemport 1` porque es el valor por
   * defecto de la pantalla, el perfil `vlan250` define `<Gem Index 250>`, y el
   * abonado quedó registrado y online pero SIN internet. Así que se lee de la
   * propia ONT y, si no cuadra con el pedido, manda la ONT y se avisa.
   */
  private async crearServicePort(p: {
    frame: number; slot: number; port: number; ontId: number;
    vlan: number; gemport: number; user_vlan?: number;
    tag_transform?: string; traffic_in?: number | string | null; traffic_out?: number | string | null;
  }): Promise<{ ok: boolean; cmd: string; salida: string; error: string; avisoGem: string | null; gemport: number }> {
    let gem = Number(p.gemport);
    let avisoGem: string | null = null;
    const gems = this.gemsDeOnt(await this.sendCommand(`display ont info ${p.frame} ${p.slot} ${p.port} ${p.ontId}`));
    if (gems.length && !gems.includes(gem)) {
      avisoGem = `El GEM-port ${gem} no existe en esta ONT (su perfil usa ${gems.join(', ')}): `
        + `se creó el service-port con el ${gems[0]}.`;
      gem = gems[0];
    }

    const uservlan = p.user_vlan !== undefined && !Number.isNaN(Number(p.user_vlan)) ? Number(p.user_vlan) : Number(p.vlan);
    const cmd = `service-port vlan ${Number(p.vlan)}`
      + ` gpon ${p.frame}/${p.slot}/${p.port} ont ${p.ontId} gemport ${gem}`
      + ` multi-service user-vlan ${uservlan}`
      + this.tagTransformArg(p)
      + this.trafficTableArgs(p);
    const out = await this.sendCommand(cmd, true);
    const fallo = /failure|fail|invalid|incorrect/i.test(out);
    return {
      ok: !fallo,
      cmd,
      salida: this.resumenDeSalida(out),
      error: fallo ? this.mensajeDeFallo(out, 'el service-port') : '',
      avisoGem,
      gemport: gem,
    };
  }

  /** GEM-ports que la ONT declara en su perfil: `<Gem Index 250>`. */
  private gemsDeOnt(out: string): number[] {
    const gems: number[] = [];
    for (const m of out.matchAll(/<\s*Gem\s+Index\s+(\d+)\s*>/gi)) {
      const n = Number(m[1]);
      if (!gems.includes(n)) gems.push(n);
    }
    return gems;
  }

  /**
   * Comprueba cómo quedó realmente una ONT recién dada de alta.
   * Devuelve `avisos` con lo que un técnico debería mirar antes de irse.
   */
  async verificarAlta(frame: number, slot: number, port: number, ontId: number): Promise<any> {
    // Justo tras el `ont add` la OLT reporta offline/initial durante unos
    // segundos: la ONU aún no ha completado el registro OMCI. Leer de inmediato
    // hace saltar alarmas falsas, así que se reintenta hasta que se estabilice.
    let info: any = {};
    let run = '', config = '', match = '';
    for (let intento = 0; intento < 4; intento++) {
      if (intento > 0) await new Promise((r) => setTimeout(r, 4000));
      const out = await this.sendCommand(`display ont info ${frame} ${slot} ${port} ${ontId}`);
      info = this.parseKvBlock(out);
      run = String(info.run_state ?? '').toLowerCase();
      config = String(info.config_state ?? '').toLowerCase();
      match = String(info.match_state ?? '').toLowerCase();
      // "initial" = todavía negociando; solo paramos cuando hay veredicto.
      if (run.includes('online') && !config.includes('initial') && !match.includes('initial')) break;
    }

    const sp = await this.servicePortsDeOnt(frame, slot, port, ontId);
    const avisos: string[] = [];
    const online = run.includes('online');

    // Los problemas REALES que impiden servicio:
    if (run.includes('offline')) {
      avisos.push('La ONU está offline: revise fibra, conectores o que el equipo esté encendido.');
    }
    if (this.avisoAlta) avisos.unshift(this.avisoAlta);
    else if (!sp.length) {
      avisos.push('La ONU quedó SIN service-port: está registrada pero no tiene servicio ni velocidad.');
    }

    // config: failed / match: mismatch en una ONU ONLINE y con service-port NO
    // es un fallo por sí solo: los OLT Huawei lo reportan de forma rutinaria con
    // ONUs de otras marcas (ZTE, etc.) que gestionan su propio WAN en modo
    // router. La ONU navega igual. Se informa, pero NO se marca como error: la
    // prueba definitiva es conectar un equipo, no este estado.
    const notaTercero =
      online && sp.length && (config.includes('fail') || match.includes('mismatch'))
        ? 'La OLT reporta config/match no-normal (habitual en ONUs de otra marca en modo router). '
          + 'La ONU está online y con servicio: confirme conectando un equipo y navegando.'
        : null;

    const ok = avisos.length === 0;
    return {
      ok,
      run_state: info.run_state ?? null,
      config_state: info.config_state ?? null,
      match_state: info.match_state ?? null,
      servicePorts: sp,
      avisos,
      nota: notaTercero,
    };
  }

  /**
   * Cola `inbound/outbound traffic-table index` del service-port: es AHÍ donde
   * se limita la velocidad del abonado (CIR/PIR), no en el line-profile ni en
   * el DBA. `inbound` es la columna RX de `display service-port` y `outbound`
   * la columna TX. OJO con los nombres: pese a lo que sugiere "inbound", RX es
   * la BAJADA del abonado y TX la SUBIDA — verificado sobre 1.551 service-ports
   * de la planta, donde RX >= TX en el 99,9% de los casos. Sin esto la ONU queda
   * sin tope explícito.
   */
  /**
   * `tag-transform`: cómo etiqueta el service-port las tramas de la ONU. Es el
   * dato que faltaba y por el que la ONU quedaba "up" pero sin navegar: los
   * service-ports que SÍ funcionan en esta planta usan `translate`; sin él, el
   * default no etiqueta como la red espera y el tráfico no llega al BNG.
   * Por defecto `translate`; se puede forzar otro modo o desactivar con "none".
   */
  private tagTransformArg(p: any): string {
    const mode = (p.tag_transform ?? 'translate').toString().toLowerCase();
    if (mode === 'none' || mode === '') return '';
    if (!['translate', 'transparent', 'default', 'add-double'].includes(mode)) return ' tag-transform translate';
    return ` tag-transform ${mode}`;
  }

  private trafficTableArgs(p: any): string {
    const inb = p.traffic_in;
    const outb = p.traffic_out;
    const val = (v: unknown) => (v !== undefined && v !== null && v !== '' ? Number(v) : null);
    const i = val(inb), o = val(outb);
    let s = '';
    if (i !== null && !Number.isNaN(i)) s += ` inbound traffic-table index ${i}`;
    if (o !== null && !Number.isNaN(o)) s += ` outbound traffic-table index ${o}`;
    return s;
  }

  /**
   * Deduce la configuración de alta mirando cómo están dados de alta los
   * abonados que YA cuelgan de ese puerto PON.
   *
   * En esta planta la VLAN la fija el puerto (slot 1 → 210+puerto*10, slot 7 →
   * 380+puerto) y el line-profile se llama igual que la VLAN. En vez de
   * codificar esa fórmula —que sería válida solo para esta OLT— se lee el
   * puerto y se toma lo mayoritario: así funciona en cualquier planta y se
   * adapta sola si mañana cambian el esquema.
   */
  async sugerenciaDePuerto(frame: number, slot: number, port: number): Promise<any> {
    const out = await this.sendCommand(`display service-port port ${frame}/${slot}/${port}`);
    const votos = { vlan: new Map<string, number>(), gem: new Map<string, number>(), rx: new Map<string, number>(), tx: new Map<string, number>() };
    const sumar = (m: Map<string, number>, v: string) => { if (v) m.set(v, (m.get(v) ?? 0) + 1); };

    let filas = 0;
    for (const line of out.split('\n')) {
      // INDEX VLAN ATTR gpon F/ S/ P VPI VCI vlan PARA RX TX STATE
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+\S+\s+\S+\s+\d+\/\s*\d+\s*\/\s*\d+\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s/);
      if (!m) continue;
      filas++;
      sumar(votos.vlan, m[2]);
      sumar(votos.gem, m[4]);
      sumar(votos.rx, m[5]);
      sumar(votos.tx, m[6]);
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const vlan = top(votos.vlan);

    // El line-profile se toma de las ONTs que YA están en el puerto, no del
    // nombre del perfil. En esta planta los perfiles se llaman "vlan380" y es
    // tentador emparejarlos con la VLAN, pero las ONTs que realmente sirven
    // usan otro (42/SmartOLT_G): elegir por el nombre deja la ONU en
    // "Config state: failed". Se muestrean unas pocas y gana la mayoría.
    const listado = this.parseOntInfo(await this.sendCommand(`display ont info ${frame} ${slot} ${port} all`));
    // El detalle de cada ONT es un comando más, así que se muestrean pocas: lo
    // que decide el resultado es CUÁLES. Antes se cogían las cuatro primeras por
    // ont-id y en esta planta eso salía casi siempre en blanco —en 0/1/10 las 47
    // ONTs están en `config: failed` menos tres, y ninguna de ellas era de las
    // cuatro primeras—, así que la orden no podía autenticar en un puerto lleno.
    // Se ordena por lo que sirve: primero las que están en `config: normal`, y
    // dentro de eso las que están online.
    const rango = (o: any) =>
      (/normal/i.test(String(o.config_state ?? '')) ? 0 : 2)
      + (/online/i.test(String(o.run_state ?? '')) ? 0 : 1);
    const idsOnt = [...listado]
      .sort((a, b) => rango(a) - rango(b))
      .map((o: any) => o.ont_id)
      .filter(Boolean)
      .slice(0, 4);
    const votosLp = new Map<string, number>();
    // Solo cuentan los perfiles de ONTs que están en `config: normal`. Elegir el
    // srv-profile por el nombre del modelo (F680→F680V9.0) parecía lo correcto,
    // pero en esta planta ese perfil deja la config en "failed"; el que sí aplica
    // es el que usan las ONTs que funcionan de verdad (genérico/13). Se decide
    // por lo que YA funciona en el puerto, no por el nombre.
    const votosSpOk = new Map<string, number>();
    /** Todos los srv-profile vistos, estén como estén: el último recurso. */
    const votosSp = new Map<string, number>();
    const srvVistos = new Map<string, string>();
    for (const oid of idsOnt) {
      const det = this.parseKvBlock(await this.sendCommand(`display ont info ${frame} ${slot} ${port} ${oid}`));
      const lp = (det['line profile id'] ?? '').toString().trim();
      const sp = (det['service profile id'] ?? '').toString().trim();
      const spName = (det['service profile name'] ?? '').toString().trim();
      const configOk = /normal/i.test(String(det['config state'] ?? ''));
      if (lp) sumar(votosLp, lp);
      if (sp) {
        srvVistos.set(sp, spName);
        sumar(votosSp, sp);
        if (configOk) sumar(votosSpOk, sp); // preferimos los que dan config normal
      }
    }
    const lineprofile = top(votosLp);

    // srv-profile sugerido = el que usan las ONTs que están en `config: normal`
    // en este mismo puerto (las que de verdad tienen servicio). Es la definición
    // literal de "clonar lo que funciona": no se adivina por modelo ni por
    // "genérico" — se copia el perfil de una ONU que ya navega ahí al lado.
    // …y si en el puerto no hay NI UNA en `config: normal` (pasa: la planta vieja
    // está llena de ONTs "failed/mismatch" que sin embargo dan servicio), se cae
    // al perfil mayoritario del puerto. Autenticar con el perfil que usan las
    // vecinas es peor que con uno normal, pero infinitamente mejor que no poder
    // autenticar: el resultado se verifica después y se avisa si queda failed.
    const srvprofile = top(votosSpOk) ?? top(votosSp);

    return {
      basadoEn: filas,
      /** Cuántas de las ONTs muestreadas estaban en `config: normal`. */
      muestraNormal: [...votosSpOk.values()].reduce((a, b) => a + b, 0),
      vlan,
      user_vlan: vlan,
      gemport: top(votos.gem),
      traffic_in: top(votos.rx),
      traffic_out: top(votos.tx),
      lineprofile,
      srvprofile,
      // Los srv-profile de las vecinas (todas), para orientar si hay que elegir.
      srvVecinos: [...srvVistos.entries()].map(([id, name]) => ({ id, name })),
    };
  }

  /** Tablas de tráfico disponibles (índice + CIR/PIR en kbps). */
  async getTrafficTables(): Promise<{ id: string; cir: string; pir: string }[]> {
    // Sin `from-index` la CLI se queda pidiendo un parámetro y envenena la sesión.
    const out = await this.sendCommand('display traffic table ip from-index 0');
    const rows: { id: string; cir: string; pir: string }[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+|off)\s+(\d+|off)\s+(\d+|off)\s+(\d+|off)\s/);
      if (m) rows.push({ id: m[1], cir: m[2], pir: m[4] });
    }
    return rows;
  }

  /** Comandos que ejecutaría provisionOnu SIN abrir sesión (dry-run). */
  buildProvisionCommands(p: any): string[] {
    const frame = Number(p.frame ?? 0) || 0;
    const slot = Number(p.slot);
    const port = Number(p.port);
    const sn = this.sanitize(p.sn ?? '', /[^A-Za-z0-9]/g);
    const cmds: string[] = [`interface gpon ${frame}/${slot}`];
    const ontidStr = p.ont_id !== undefined && p.ont_id !== '' && p.ont_id !== null ? ' ' + Number(p.ont_id) : '';
    let cmd = `ont add ${port}${ontidStr} sn-auth "${sn}" omci`
      + ` ont-lineprofile-id ${Number(p.lineprofile)} ont-srvprofile-id ${Number(p.srvprofile)}`;
    if (p.desc) cmd += ` desc "${this.sanitize(p.desc)}"`;
    cmds.push(cmd, 'quit');
    if (p.vlan && p.gemport !== '' && p.gemport !== null && p.gemport !== undefined) {
      const uservlan = p.user_vlan ? Number(p.user_vlan) : Number(p.vlan);
      cmds.push(
        `service-port vlan ${Number(p.vlan)} gpon ${frame}/${slot}/${port} ont <ont-id>`
        + ` gemport ${Number(p.gemport)} multi-service user-vlan ${uservlan}`
        + this.tagTransformArg(p)
        + this.trafficTableArgs(p),
      );
    }
    return cmds;
  }

  /**
   * Detalle de una ONU (estado, distancia, up/down): UN solo comando para que
   * la ficha abra rápido. La óptica va aparte (getOntOptical): es el comando
   * lento porque la OLT interroga el transceiver en vivo.
   */
  async getOntDetail(frame: number, slot: number, port: number, ontid: number): Promise<any | false> {
    const f = Number(frame) || 0, s = Number(slot), p = Number(port), id = Number(ontid);
    const out = await this.sendCommand(`display ont info ${f} ${s} ${p} ${id}`);
    // "Failure: The ONT does not exist": en esa posición ya no hay ONU (la movieron
    // de puerto o la borraron). Antes se parseaba como un bloque con la clave
    // "failure" y la ficha lo contaba como "la OLT no devolvió lecturas".
    const fallo = out.match(/^\s*Failure:\s*(.+?)\s*$/im);
    if (fallo) { this.error = fallo[1]; return false; }
    const info = this.parseKvBlock(out);
    if (!Object.keys(info).length) { this.error = 'No se pudo leer el detalle de la ONT.'; return false; }
    return info;
  }

  /** Señal óptica en vivo de una ONU (RX/TX/temperatura/voltaje/distancia). */
  async getOntOptical(frame: number, slot: number, port: number, ontid: number): Promise<any | false> {
    const f = Number(frame) || 0, s = Number(slot), p = Number(port), id = Number(ontid);
    await this.sendCommand(`interface gpon ${f}/${s}`);
    const opt = await this.sendCommand(`display ont optical-info ${p} ${id}`);
    await this.sendCommand('quit');
    const fallo = opt.match(/^\s*Failure:\s*(.+?)\s*$/im);
    if (fallo) { this.error = fallo[1]; return false; }
    // Para UNA ONU el MA5800 responde un bloque clave:valor ("Rx optical
    // power(dBm) : -18.50"), no la fila tabular del "... all". Se lee el bloque
    // y se conserva la fila como respaldo por si otro firmware la usa.
    const row = {
      rx: this.kv(opt, 'Rx optical power\\(dBm\\)'),
      tx: this.kv(opt, 'Tx optical power\\(dBm\\)'),
      olt_rx: this.kv(opt, 'OLT Rx ONT optical power\\(dBm\\)'),
      temp: this.kv(opt, 'Temperature\\(C\\)'),
      voltage: this.kv(opt, 'Voltage\\(V\\)'),
      current: this.kv(opt, 'Laser bias current\\(mA\\)'),
    };
    if (row.rx || row.tx || row.olt_rx) return row;
    return this.parseOpticalRow(opt, id);
  }

  /** Busca una ONU por su SN en toda la OLT. */
  async findBySn(sn: string): Promise<any | false> {
    sn = this.sanitize(sn, /[^A-Za-z0-9]/g);
    if (sn === '') { this.error = 'SN inválido.'; return false; }
    const out = await this.sendCommand(`display ont info by-sn ${sn}`);
    if (/failure|does not exist|the required ont does not|invalid/i.test(out)) {
      this.error = 'No se encontró ninguna ONU con ese SN.';
      return false;
    }
    const info = this.parseKvBlock(out);
    if (!Object.keys(info).length || info.fsp === undefined) {
      this.error = 'No se encontró ninguna ONU con ese SN.';
      return false;
    }
    return info;
  }

  /**
   * Dónde está y cómo está una ONU que YA existe en la OLT, buscándola por SN.
   *
   * Es lo que hay que saber para decidir qué hacer con una ONU que rechaza el
   * alta por "SN already exists": en qué puerto quedó, si está navegando y con
   * qué velocidad. Sin esto lo único que se sabía es que el alta falló.
   */
  async estadoPorSn(sn: string): Promise<{
    fsp: string; frame: number; slot: number; port: number; ont_id: number;
    run_state: string; config_state: string; match_state: string; description: string;
    lineprofile: string; srvprofile: string; srvprofile_name: string;
    servicePorts: { index: string; vlan: string; gemport: string; rx: string; tx: string }[];
  } | null> {
    const info = await this.findBySn(sn);
    if (!info) return null;
    const m = String(info.fsp ?? '').match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
    if (!m || info.ont_id === undefined) return null;
    const [frame, slot, port] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ontId = Number(info.ont_id);
    const servicePorts = await this.servicePortsDetalleDeOnt(frame, slot, port, ontId);
    return {
      fsp: `${frame}/${slot}/${port}`,
      frame, slot, port, ont_id: ontId,
      run_state: String(info.run_state ?? ''),
      config_state: String(info.config_state ?? ''),
      match_state: String(info.match_state ?? ''),
      description: String(info.description ?? ''),
      lineprofile: String(info['line profile id'] ?? ''),
      srvprofile: String(info['service profile id'] ?? ''),
      srvprofile_name: String(info['service profile name'] ?? ''),
      servicePorts,
    };
  }

  /**
   * ADOPTA una ONU que ya está autenticada en la OLT: la deja con el comentario
   * y la velocidad que le tocan, sin volver a darla de alta.
   *
   * Es la salida al caso real: la ONU se autenticó desde otro sitio (SmartOLT, a
   * mano) y el abonado está navegando, pero para el sistema no existe. Borrarla
   * y rehacerla dejaría al cliente sin servicio durante el proceso y, con las
   * ZTE, es justo lo que las deja pegadas en "config: failed". Aquí NO se toca
   * el `ont add`: solo el comentario y las traffic-tables del service-port.
   */
  async adoptarOnu(p: {
    sn: string; desc?: string | null;
    traffic_in?: number | string | null; traffic_out?: number | string | null;
    /** Solo se usan si la ONU está SIN service-port y hay que crearle uno. */
    vlan?: number | string | null; gemport?: number | string | null;
    user_vlan?: number | string | null; tag_transform?: string;
  }): Promise<any | false> {
    this.avisoAlta = '';
    const sn = this.sanitize(p.sn ?? '', /[^A-Za-z0-9]/g);
    if (sn === '') { this.error = 'SN inválido o vacío.'; return false; }

    const estado = await this.estadoPorSn(sn);
    if (!estado) {
      this.error = 'Esa ONU no está autenticada en esta OLT: no hay nada que adoptar (hay que darla de alta).';
      return false;
    }

    const commands: string[] = [];
    const cambios: string[] = [];
    const avisos: string[] = [];

    // 0) Sin service-port la ONU está registrada pero sin internet: adoptarla
    //    tiene que poder arreglar eso, o el técnico se queda encerrado (no puede
    //    volver a darla de alta —el SN ya existe— ni cambiarle una velocidad que
    //    no tiene). Se crea con lo que ya funciona en el puerto.
    if (!estado.servicePorts.length) {
      const sug = await this.sugerenciaDePuerto(estado.frame, estado.slot, estado.port);
      const elegir = (...vs: any[]) => {
        for (const v of vs) if (v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v))) return Number(v);
        return null;
      };
      const vlan = elegir(p.vlan, sug.vlan);
      if (vlan === null) {
        avisos.push('La ONU no tiene service-port y no se pudo deducir la VLAN del puerto: '
          + 'sigue sin servicio. Hay que crearlo a mano en la OLT.');
      } else {
        const r = await this.crearServicePort({
          frame: estado.frame, slot: estado.slot, port: estado.port, ontId: estado.ont_id,
          vlan,
          gemport: elegir(p.gemport, sug.gemport, 1)!,
          user_vlan: elegir(p.user_vlan, sug.user_vlan, vlan)!,
          tag_transform: p.tag_transform,
          // Si no se pidió velocidad, se copia la del puerto: dejarlo sin
          // traffic-table sería dejar al abonado sin tope.
          traffic_in: elegir(p.traffic_in, sug.traffic_in),
          traffic_out: elegir(p.traffic_out, sug.traffic_out),
        });
        commands.push(r.cmd);
        if (r.avisoGem) avisos.push(r.avisoGem);
        if (r.ok) {
          cambios.push(`service-port creado (VLAN ${vlan}, GEM ${r.gemport})`);
          // Ya tiene servicio: la velocidad va dentro de este mismo comando, no
          // hace falta el paso de reapuntar traffic-tables de más abajo.
          estado.servicePorts = await this.servicePortsDetalleDeOnt(estado.frame, estado.slot, estado.port, estado.ont_id);
        } else {
          avisos.push('No se pudo crear el service-port que le falta: ' + r.error);
        }
      }
    }

    // 1) Comentario. Solo si se pide y es distinto del que ya tiene: reescribir
    //    el mismo texto es un comando de escritura gratis contra el equipo.
    const desc = p.desc === undefined || p.desc === null ? null : this.sanitize(String(p.desc));
    if (desc !== null && desc !== estado.description) {
      const anterior = estado.description;
      const r = await this.setOnuDescription({
        frame: estado.frame, slot: estado.slot, port: estado.port, ont_id: estado.ont_id, desc,
      });
      commands.push(`interface gpon ${estado.frame}/${estado.slot}`,
        `ont modify ${estado.port} ${estado.ont_id} desc "${desc}"`, 'quit');
      if (r === false) avisos.push(`No se pudo cambiar el comentario: ${this.error}`);
      else cambios.push(`comentario "${anterior || '(vacío)'}" → "${desc}"`);
    }

    // 2) Velocidad. Igual: si el service-port ya está en las tablas pedidas no
    //    se manda nada (la ONU ya está como debe).
    const val = (v: unknown) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    const inb = val(p.traffic_in), outb = val(p.traffic_out);
    let velocidad: any = null;
    if (inb !== null || outb !== null) {
      const sp = estado.servicePorts;
      const yaEsta = sp.length === 1
        && (inb === null || Number(sp[0].rx) === inb)
        && (outb === null || Number(sp[0].tx) === outb);
      if (yaEsta) {
        cambios.push(`velocidad ya correcta (bajada tt ${sp[0].rx} / subida tt ${sp[0].tx})`);
      } else {
        const r = await this.setServicePortSpeed({
          frame: estado.frame, slot: estado.slot, port: estado.port, ontId: estado.ont_id,
          traffic_in: inb, traffic_out: outb,
        });
        if (r === false) {
          // La velocidad es media adopción: si falla se dice, pero lo demás
          // (comentario, vínculo) ya vale y no se tira por la borda.
          avisos.push(`No se pudo aplicar la velocidad del plan: ${this.error}`);
        } else {
          velocidad = r;
          commands.push(...(r.commands ?? []));
          cambios.push(`velocidad → bajada tt ${r.despues?.traffic_in ?? inb} / subida tt ${r.despues?.traffic_out ?? outb}`);
        }
      }
    }

    // 3) Releer para devolver el estado real con el que queda (mismos avisos
    //    que un alta: online, service-ports, config/match).
    const verificacion = await this.verificarAlta(estado.frame, estado.slot, estado.port, estado.ont_id);

    return {
      ok: true,
      adoptada: true,
      message: `ONU adoptada en ${estado.fsp} (ONT-ID ${estado.ont_id})`
        + (cambios.length ? ': ' + cambios.join(' · ') : ' (no hizo falta cambiar nada).'),
      ont_id: String(estado.ont_id),
      fsp: estado.fsp,
      frame: estado.frame, slot: estado.slot, port: estado.port,
      antes: estado,
      cambios, avisos, velocidad, commands,
      verificacion,
    };
  }

  /**
   * Estado de los puertos CATV (RF por coaxial) de una ONT:
   *   interface gpon <f>/<s> ; display ont port state <p> <ontid> catv-port all ; quit
   * Filas: "2  1  CATV  up  19.000" → { portId, linkState, txPower }.
   */
  async getCatvPorts(frame: number, slot: number, port: number, ontid: number): Promise<any[] | false> {
    const f = Number(frame) || 0, s = Number(slot), p = Number(port), id = Number(ontid);
    await this.sendCommand(`interface gpon ${f}/${s}`);
    const out = await this.sendCommand(`display ont port state ${p} ${id} catv-port all`);
    await this.sendCommand('quit');
    if (/failure|does not exist|invalid|no CATV/i.test(out)) {
      this.error = this.mensajeDeFallo(out, 'catv');
      return false;
    }
    const ports: any[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+CATV\s+(\S+)\s+(\S+)/i);
      if (m && Number(m[1]) === id) ports.push({ portId: Number(m[2]), linkState: m[3].toLowerCase(), txPower: m[4] });
    }
    if (!ports.length) { this.error = 'La ONT no reporta puertos CATV.'; return false; }
    return ports;
  }

  /**
   * Enciende/apaga el puerto CATV de una ONT (corte de TV por OMCI):
   *   interface gpon <f>/<s> ; ont port attribute <p> <ontid> catv <n> operational-state on|off ; quit
   */
  async setCatvState(p: any): Promise<any | false> {
    const f = Number(p.frame ?? 0) || 0;
    const s = p.slot !== undefined && p.slot !== '' ? Number(p.slot) : null;
    const port = p.port !== undefined && p.port !== '' ? Number(p.port) : null;
    const id = p.ont_id !== undefined && p.ont_id !== '' ? Number(p.ont_id) : null;
    const catvPort = Number(p.catvPort ?? 1) || 1;
    const enable = p.enable === true;
    if (s === null || port === null || id === null) {
      this.error = 'Faltan datos (slot/puerto/ont-id).';
      return false;
    }
    await this.sendCommand(`interface gpon ${f}/${s}`);
    const out = await this.sendCommand(`ont port attribute ${port} ${id} catv ${catvPort} operational-state ${enable ? 'on' : 'off'}`, true);
    await this.sendCommand('quit');
    if (/failure|fail|invalid|incorrect|does not exist|unknown command/i.test(out)) {
      this.error = this.mensajeDeFallo(out, 'catv');
      return false;
    }
    return {
      ok: true,
      message: `Puerto CATV ${catvPort} ${enable ? 'ACTIVADO' : 'CORTADO'} (${f}/${s}/${port}:${id}).`,
      catvPort, enable,
    };
  }

  async rebootOnu(p: any): Promise<any | false> {
    return this.accionOnu('reset', p);
  }
  async deleteOnu(p: any): Promise<any | false> {
    return this.accionOnu('delete', p);
  }

  /**
   * Cambia la descripción (comentario) de una ONT ya autorizada:
   *   interface gpon <f>/<s> ; ont modify <port> <ontid> desc "<desc>" ; quit
   * Con desc vacío la deja sin comentario (la OLT vuelve a ONT_NO_DESCRIPTION).
   */
  async setOnuDescription(p: any): Promise<any | false> {
    const f = Number(p.frame ?? 0) || 0;
    const s = p.slot !== undefined && p.slot !== '' ? Number(p.slot) : null;
    const port = p.port !== undefined && p.port !== '' ? Number(p.port) : null;
    const id = p.ont_id !== undefined && p.ont_id !== '' ? Number(p.ont_id) : null;
    if (s === null || port === null || id === null) {
      this.error = 'Faltan datos (slot/puerto/ont-id).';
      return false;
    }
    const desc = this.sanitize(p.desc ?? '');
    await this.sendCommand(`interface gpon ${f}/${s}`);
    const out = await this.sendCommand(`ont modify ${port} ${id} desc "${desc}"`, true);
    await this.sendCommand('quit');
    if (/failure|fail|invalid|incorrect|does not exist/i.test(out)) {
      this.error = this.mensajeDeFallo(out, 'modify');
      return false;
    }
    return { ok: true, message: `Comentario actualizado (${f}/${s}/${port}:${id}).`, desc };
  }

  private async accionOnu(accion: 'reset' | 'delete', p: any): Promise<any | false> {
    const f = Number(p.frame ?? 0) || 0;
    const s = p.slot !== undefined && p.slot !== '' ? Number(p.slot) : null;
    const port = p.port !== undefined && p.port !== '' ? Number(p.port) : null;
    const id = p.ont_id !== undefined && p.ont_id !== '' ? Number(p.ont_id) : null;
    if (s === null || port === null || id === null) {
      this.error = 'Faltan datos (slot/puerto/ont-id).';
      return false;
    }
    // Una ONT con service-ports no se puede borrar: Huawei responde
    // "This configured object has some service virtual ports". Se arrastran
    // siempre, porque borrar la ONU sin sus servicios no es una operación que
    // el operador pueda querer: la confirmación previa (con serial tecleado)
    // es la puerta deliberada, no un segundo paso aquí.
    const quitados: string[] = [];
    if (accion === 'delete') {
      for (const idx of await this.servicePortsDeOnt(f, s, port, id)) {
        await this.sendCommand(`undo service-port ${idx}`, true);
        quitados.push(idx);
      }
    }

    await this.sendCommand(`interface gpon ${f}/${s}`);
    const out = await this.sendCommand(`ont ${accion} ${port} ${id}`, true);
    await this.sendCommand('quit');
    if (/failure|fail|invalid|incorrect|does not exist/i.test(out)) {
      this.error = this.mensajeDeFallo(out, accion);
      return false;
    }
    const suf = quitados.length ? ` Se eliminaron ${quitados.length} service-port(s): ${quitados.join(', ')}.` : '';
    return {
      ok: true,
      message: (accion === 'reset' ? 'ONU reiniciada' : 'ONU eliminada') + ` (${f}/${s}/${port}:${id}).` + suf,
      servicePorts: quitados,
    };
  }

  /**
   * Índices de service-port asociados a una ONT concreta. En la salida de
   * `display service-port port F/S/P` la columna VPI es el ONT-ID.
   */
  async servicePortsDeOnt(frame: number, slot: number, port: number, ontId: number): Promise<string[]> {
    const out = await this.sendCommand(`display service-port port ${frame}/${slot}/${port}`);
    const idx: string[] = [];
    for (const line of out.split('\n')) {
      // INDEX VLAN VLANATTR PORTTYPE F/ S/ P VPI VCI ...
      const m = line.match(/^\s*(\d+)\s+\d+\s+\S+\s+\S+\s+\d+\/\s*\d+\s*\/\s*\d+\s+(\d+)\s+/);
      if (m && Number(m[2]) === Number(ontId)) idx.push(m[1]);
    }
    return idx;
  }

  /**
   * Igual que `servicePortsDeOnt` pero con las columnas que hacen falta para
   * CAMBIAR la velocidad: índice + traffic-table actual de cada sentido.
   * Columnas: INDEX VLAN VLANATTR PORTTYPE F/S/P VPI VCI user-vlan tag RX TX STATE
   * (VPI = ONT-ID, VCI = GEM-port, RX = inbound = BAJADA, TX = outbound = SUBIDA).
   */
  async servicePortsDetalleDeOnt(
    frame: number, slot: number, port: number, ontId: number,
  ): Promise<{ index: string; vlan: string; gemport: string; rx: string; tx: string }[]> {
    const todos = await this.servicePortsDePuerto(frame, slot, port);
    return todos.filter((f) => Number(f.ontId) === Number(ontId));
  }

  /**
   * TODOS los service-ports de un puerto PON, con la ONT a la que pertenece cada
   * uno. Un solo comando devuelve las decenas de ONTs del puerto: leer ONT por
   * ONT sería una sesión de comandos por abonado.
   *
   * Es la lectura con la que se averigua a qué velocidad está funcionando de
   * verdad cada plan en la planta (RX = bajada del abonado, TX = subida).
   */
  async servicePortsDePuerto(
    frame: number, slot: number, port: number,
  ): Promise<{ index: string; vlan: string; ontId: string; gemport: string; rx: string; tx: string }[]> {
    const out = await this.sendCommand(`display service-port port ${frame}/${slot}/${port}`);
    const filas: { index: string; vlan: string; ontId: string; gemport: string; rx: string; tx: string }[] = [];
    for (const line of out.split('\n')) {
      // INDEX VLAN VLANATTR PORTTYPE F/S/P VPI VCI user-vlan tag RX TX STATE
      // (VPI = ONT-ID, VCI = GEM-port)
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+\S+\s+\S+\s+\d+\/\s*\d+\s*\/\s*\d+\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s/);
      if (m) filas.push({ index: m[1], vlan: m[2], ontId: m[3], gemport: m[4], rx: m[5], tx: m[6] });
    }
    return filas;
  }

  /**
   * Cambia la VELOCIDAD de una ONU ya autenticada, sin volver a darla de alta:
   * reapunta las traffic-tables del service-port que ya existe.
   *
   *   service-port <index> inbound traffic-table index <in> outbound traffic-table index <out>
   *
   * Se VERIFICA releyendo `display service-port`: que el CLI no devuelva "Failure"
   * no basta —es el mismo fallo silencioso del alta— y aquí el riesgo es peor,
   * porque un abonado que cree que le subieron las megas y sigue igual no
   * reclama hasta el mes siguiente. Si tras el cambio las columnas RX/TX no son
   * las pedidas, se devuelve error: NO se recrea el service-port por nuestra
   * cuenta (eso sí dejaría al abonado sin servicio si algo sale mal).
   */
  async setServicePortSpeed(p: {
    frame: number; slot: number; port: number; ontId: number;
    traffic_in?: number | string | null; traffic_out?: number | string | null;
  }): Promise<any | false> {
    const f = Number(p.frame) || 0, s = Number(p.slot), pt = Number(p.port), id = Number(p.ontId);
    const val = (v: unknown) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    const inb = val(p.traffic_in), outb = val(p.traffic_out);
    if (inb === null && outb === null) { this.error = 'No se indicó ninguna traffic-table.'; return false; }

    const antes = await this.servicePortsDetalleDeOnt(f, s, pt, id);
    if (!antes.length) {
      this.error = 'La ONU no tiene service-port: no hay velocidad que cambiar (hay que autenticarla primero).';
      return false;
    }
    // Con varios service-ports (internet + TV/voz) no se puede saber cuál es el
    // de datos desde aquí, y tocarlos todos rompería la TV. Se para y se dice.
    if (antes.length > 1) {
      this.error = `La ONU tiene ${antes.length} service-ports (${antes.map((x) => x.index).join(', ')}). `
        + 'No se toca automáticamente: hay que ajustar el de datos a mano en la OLT.';
      return false;
    }

    const sp = antes[0];
    let cmd = `service-port ${sp.index}`;
    if (inb !== null) cmd += ` inbound traffic-table index ${inb}`;
    if (outb !== null) cmd += ` outbound traffic-table index ${outb}`;
    const out = await this.sendCommand(cmd, true);
    if (/failure|invalid|incorrect|unknown command|parameter/i.test(out)) {
      this.error = this.mensajeDeFallo(out, 'cambio de velocidad');
      return false;
    }

    // Releer y comparar. La OLT tarda un instante en reflejarlo.
    let despues = antes;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 800 : 1200));
      const leido = await this.servicePortsDetalleDeOnt(f, s, pt, id);
      const fila = leido.find((x) => x.index === sp.index);
      if (!fila) continue;
      despues = leido;
      const okIn = inb === null || Number(fila.rx) === inb;
      const okOut = outb === null || Number(fila.tx) === outb;
      if (okIn && okOut) {
        return {
          ok: true,
          message: `Velocidad aplicada al service-port ${sp.index}`
            + (outb !== null ? ` · bajada traffic-table ${outb}` : '')
            + (inb !== null ? ` · subida traffic-table ${inb}` : '') + '.',
          servicePort: sp.index,
          antes: { traffic_in: sp.rx, traffic_out: sp.tx },
          despues: { traffic_in: fila.rx, traffic_out: fila.tx },
          commands: [cmd],
        };
      }
    }
    const fila = despues.find((x) => x.index === sp.index);
    this.error = 'La OLT aceptó el comando pero el service-port sigue con las tablas anteriores '
      + `(subida ${fila?.rx ?? '?'}, bajada ${fila?.tx ?? '?'}). No se dio por hecho el cambio.`;
    return false;
  }

  /** Comandos que ejecutaría setServicePortSpeed SIN abrir sesión (dry-run). */
  buildSpeedCommands(p: { traffic_in?: number | string | null; traffic_out?: number | string | null }): string[] {
    let cmd = 'service-port <índice del service-port de la ONU>';
    if (p.traffic_in !== undefined && p.traffic_in !== null && p.traffic_in !== '') cmd += ` inbound traffic-table index ${Number(p.traffic_in)}`;
    if (p.traffic_out !== undefined && p.traffic_out !== null && p.traffic_out !== '') cmd += ` outbound traffic-table index ${Number(p.traffic_out)}`;
    return [`display service-port port <F/S/P de la ONU>`, cmd];
  }

  /**
   * Traduce el `Failure:` del CLI a algo accionable. Antes se devolvía siempre
   * "revise la salida cruda", que obliga al operador a leer un volcado SSH para
   * enterarse de algo que el equipo ya había dicho en una línea.
   */
  private mensajeDeFallo(out: string, accion: string): string {
    const linea = (out.split('\n').find((l) => /failure|error:/i.test(l)) ?? '').trim();
    if (/service virtual ports/i.test(out)) {
      return 'La ONU tiene servicios (service-ports) asociados y la OLT no deja borrarla así. '
        + 'Hay que eliminar primero sus service-ports: eso deja al abonado sin servicio.';
    }
    // Ojo con "does not exist" a secas: también lo dice de un PERFIL que falta,
    // y contestar "esa ONU ya no existe" manda a buscar donde no es.
    if (/required ont does not exist|the ont does not exist/i.test(out)) {
      return 'Esa ONU ya no existe en la OLT (puede que la hayan borrado desde otro sitio).';
    }
    // Etiqueta legible de lo que se intentaba: la que venga ya redactada
    // ("el alta", "el cambio de velocidad") se respeta.
    const que = accion === 'delete' ? 'el borrado'
      : accion === 'reset' ? 'el reinicio'
      : /^(el|la|los|las) /.test(accion) ? accion
      : 'la acción';
    return linea
      ? `La OLT rechazó ${que}: ${linea.replace(/^\s*Failure:\s*/i, '')}`
      : `La OLT rechazó ${que} sin dar detalle.`;
  }

  /**
   * La respuesta de un comando de escritura en dos líneas: el eco del CLI sobra
   * y el volcado entero no cabe en un log. Se queda con lo que dice el equipo.
   */
  private resumenDeSalida(out: string): string {
    const lineas = out.split('\n')
      .map((l) => l.replace(/\r/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim())
      .filter((l) => l !== '' && !/^-+$/.test(l) && !/^\{.*\}:$/.test(l) && !/More \( Press/.test(l));
    const dichas = lineas.filter((l) => /failure|error|success|command|ont ?id|ontid/i.test(l));
    return (dichas.length ? dichas : lineas.slice(-3)).join(' | ').slice(0, 500);
  }

  /* ------------------------------- parsers ------------------------------- */

  private parseKvBlock(out: string): any {
    const r: any = {};
    let ultima = '';
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 /()\-.]+?)\s*:\s*(.+?)\s*$/);
      if (m) {
        const key = m[1].trim().toLowerCase();
        const val = m[2].trim();
        ultima = key;
        if (/^-+$/.test(val)) continue;
        r[key] = val;
        continue;
      }
      // La OLT parte el comentario largo en varias líneas alineadas bajo el
      // valor, sin repetir la clave: "Dr," / "Orlando_zone_PRINCIPAL_authd_202"
      // / "60818". Quedándose con la primera, un comentario de abonado se leía
      // como "Dr," — y con eso no casa ni el auto-vinculador ni nada.
      if (ultima === 'description' && /^\s{8,}\S/.test(line) && !line.includes(':')) {
        r.description = String(r.description ?? '') + line.trim();
      }
    }
    if (!Object.keys(r).length) return {};
    const map: Record<string, string> = {
      'f/s/p': 'fsp', 'ont-id': 'ont_id', 'run state': 'run_state',
      'config state': 'config_state', 'match state': 'match_state',
      'control flag': 'control_flag', 'sn': 'sn', 'description': 'description',
      'ont distance(m)': 'distance', 'authentic type': 'auth_type',
      'management mode': 'mgmt_mode', 'last up time': 'last_up',
      'last down time': 'last_down', 'last down cause': 'last_down_cause',
      'ont online duration': 'online_duration', 'dba type': 'dba_type',
    };
    const out2 = { ...r };
    for (const [long, short] of Object.entries(map)) {
      if (r[long] !== undefined) out2[short] = r[long];
    }
    if (out2.sn !== undefined) out2.sn = String(out2.sn).replace(/\s*\(.*$/, '');
    return out2;
  }

  private parseOpticalRow(out: string, id: number): any {
    for (const line of out.split('\n')) {
      const m = line.match(new RegExp('^\\s*' + id + '\\s+(-?\\d+\\.\\d+)\\s+(-?\\d+\\.\\d+)\\s+(-?\\d+\\.\\d+)\\s+(\\d+)\\s+([\\d.]+)\\s+(\\d+)\\s+(\\d+)'));
      if (m) return { rx: m[1], tx: m[2], olt_rx: m[3], temp: m[4], voltage: m[5], current: m[6], distance: m[7] };
    }
    return {};
  }

  private parseProfiles(out: string): any[] {
    const rows: any[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)/);
      if (m) {
        if (m[2].toLowerCase() === 'profile-name') continue;
        rows.push({ id: m[1], name: m[2] });
      }
    }
    return rows;
  }

  private parseOntInfo(out: string): any[] {
    const rows: any[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+\s*\/\s*\d+\s*\/\s*\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (m) {
        rows.push({
          fsp: m[1].replace(/\s+/g, ''),
          ont_id: m[2],
          sn: m[3],
          control_flag: m[4],
          run_state: m[5],
          config_state: m[6],
          match_state: m[7],
          rx_power: '',
        });
      }
    }
    // Segunda tabla del listado ("F/S/P  ONT-ID  Description"): ahí vive el
    // comentario del abonado. La OLT pone "ONT_NO_DESCRIPTION" cuando no hay.
    let enDesc = false;
    const desc: Record<string, string> = {};
    for (const line of out.split('\n')) {
      if (/ONT-ID\s+Description/i.test(line)) { enDesc = true; continue; }
      if (!enDesc) continue;
      const m = line.match(/^\s*(\d+\s*\/\s*\d+\s*\/\s*\d+)\s+(\d+)\s+(\S.*?)\s*$/);
      if (!m) continue;
      const d = m[3] === 'ONT_NO_DESCRIPTION' ? '' : m[3];
      desc[m[1].replace(/\s+/g, '') + ':' + m[2]] = d;
    }
    if (enDesc) {
      for (const r of rows) r.description = desc[r.fsp + ':' + r.ont_id] ?? '';
    }
    return rows;
  }

  private parseOptical(out: string): Record<string, string> {
    const rx: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(-?\d+\.\d+)/);
      if (m) rx[m[1]] = m[2];
    }
    return rx;
  }

  /** Extrae el valor de una línea "clave : valor" (sin cruzar de línea). */
  private kv(block: string, keyRegex: string): string {
    const m = block.match(new RegExp('(?:' + keyRegex + ')[ \\t]*:[ \\t]*([^\\r\\n]*)', 'i'));
    if (m) {
      const val = m[1].trim();
      if (/^-+$/.test(val)) return '';
      return val;
    }
    return '';
  }
}
