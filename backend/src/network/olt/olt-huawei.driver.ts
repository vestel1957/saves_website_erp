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
    if ((m = ver.match(/\b(MA\d{4}[A-Z0-9\-]*)/i))) info.model = m[1];
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

    // 4) (Opcional) service-port si se indicó VLAN + gemport.
    if (p.vlan && p.gemport !== '' && p.gemport !== null && p.gemport !== undefined && ontId !== '') {
      const uservlan = p.user_vlan ? Number(p.user_vlan) : Number(p.vlan);
      const sp = `service-port vlan ${Number(p.vlan)}`
        + ` gpon ${frame}/${slot}/${port} ont ${ontId} gemport ${Number(p.gemport)}`
        + ` multi-service user-vlan ${uservlan}`;
      const spout = await this.sendCommand(sp, true);
      commands.push(sp);
      if (/failure|fail|invalid|incorrect/i.test(spout)) {
        this.error = 'La ONT se agregó pero el service-port falló. Revise la salida cruda.';
        // No retornamos false: la ONT quedó creada.
      }
    }

    return {
      ok: true,
      message: 'ONT agregada' + (ontId !== '' ? ` (ONT-ID ${ontId})` : '') + '.',
      ont_id: ontId,
      commands,
    };
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
      cmds.push(`service-port vlan ${Number(p.vlan)} gpon ${frame}/${slot}/${port} ont <ont-id> gemport ${Number(p.gemport)} multi-service user-vlan ${uservlan}`);
    }
    return cmds;
  }

  /** Detalle completo de una ONU (estado, distancia, up/down, óptica). */
  async getOntDetail(frame: number, slot: number, port: number, ontid: number): Promise<any | false> {
    const f = Number(frame) || 0, s = Number(slot), p = Number(port), id = Number(ontid);
    const out = await this.sendCommand(`display ont info ${f} ${s} ${p} ${id}`);
    const info = this.parseKvBlock(out);
    if (!Object.keys(info).length) { this.error = 'No se pudo leer el detalle de la ONT.'; return false; }
    await this.sendCommand(`interface gpon ${f}/${s}`);
    const opt = await this.sendCommand(`display ont optical-info ${p} ${id}`);
    await this.sendCommand('quit');
    info.optical = this.parseOpticalRow(opt, id);
    return info;
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

  async rebootOnu(p: any): Promise<any | false> {
    return this.accionOnu('reset', p);
  }
  async deleteOnu(p: any): Promise<any | false> {
    return this.accionOnu('delete', p);
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
    await this.sendCommand(`interface gpon ${f}/${s}`);
    const out = await this.sendCommand(`ont ${accion} ${port} ${id}`, true);
    await this.sendCommand('quit');
    if (/failure|fail|invalid|incorrect|does not exist/i.test(out)) {
      this.error = 'La OLT reportó un error en la acción. Revise la salida cruda.';
      return false;
    }
    return { ok: true, message: (accion === 'reset' ? 'ONU reiniciada' : 'ONU eliminada') + ` (${f}/${s}/${port}:${id}).` };
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
