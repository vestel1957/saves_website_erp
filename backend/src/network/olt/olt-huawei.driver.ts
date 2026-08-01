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
    const frame = Number(p.frame ?? 0) || 0;
    const slot = p.slot !== undefined && p.slot !== null && p.slot !== '' ? Number(p.slot) : null;
    const port = p.port !== undefined && p.port !== null && p.port !== '' ? Number(p.port) : null;
    const sn = this.sanitize(p.sn ?? '', /[^A-Za-z0-9]/g);

    if (slot === null || port === null) { this.error = 'Debe indicar slot y puerto.'; return false; }
    if (sn === '') { this.error = 'SN inválido o vacío.'; return false; }
    if (!p.lineprofile || !p.srvprofile) { this.error = 'Debe indicar line-profile y srv-profile.'; return false; }

    const commands: string[] = [];

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

    if (/failure|fail|invalid|incorrect|conflict|already exist|repeat/i.test(out)) {
      await this.sendCommand('quit');
      this.error = 'La OLT reportó un error al agregar la ONT. Revise la salida cruda.';
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
      const uservlan = p.user_vlan ? Number(p.user_vlan) : Number(p.vlan);
      const sp = `service-port vlan ${Number(p.vlan)}`
        + ` gpon ${frame}/${slot}/${port} ont ${ontId} gemport ${Number(p.gemport)}`
        + ` multi-service user-vlan ${uservlan}`
        + this.tagTransformArg(p)
        + this.trafficTableArgs(p);
      const spout = await this.sendCommand(sp, true);
      commands.push(sp);
      if (/failure|fail|invalid|incorrect/i.test(spout)) {
        this.error = 'La ONT se agregó pero el service-port falló. Revise la salida cruda.';
        // No retornamos false: la ONT quedó creada.
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
      verificacion,
    };
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
    const idsOnt = this.parseOntInfo(await this.sendCommand(`display ont info ${frame} ${slot} ${port} all`))
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
        if (configOk) sumar(votosSpOk, sp); // solo perfiles que dan config normal
      }
    }
    const lineprofile = top(votosLp);

    // srv-profile sugerido = el que usan las ONTs que están en `config: normal`
    // en este mismo puerto (las que de verdad tienen servicio). Es la definición
    // literal de "clonar lo que funciona": no se adivina por modelo ni por
    // "genérico" — se copia el perfil de una ONU que ya navega ahí al lado.
    const srvprofile = top(votosSpOk);

    return {
      basadoEn: filas,
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
    if (/does not exist|the required ont/i.test(out)) {
      return 'Esa ONU ya no existe en la OLT (puede que la hayan borrado desde otro sitio).';
    }
    return linea
      ? `La OLT rechazó ${accion === 'delete' ? 'el borrado' : 'la acción'}: ${linea.replace(/^\s*Failure:\s*/i, '')}`
      : `La OLT rechazó ${accion === 'delete' ? 'el borrado' : 'la acción'} sin dar detalle.`;
  }

  /* ------------------------------- parsers ------------------------------- */

  private parseKvBlock(out: string): any {
    const r: any = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 /()\-.]+?)\s*:\s*(.+?)\s*$/);
      if (m) {
        const key = m[1].trim().toLowerCase();
        const val = m[2].trim();
        if (/^-+$/.test(val)) continue;
        r[key] = val;
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
