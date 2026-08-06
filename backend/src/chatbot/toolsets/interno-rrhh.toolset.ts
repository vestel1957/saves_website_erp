import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { StaffService } from '../../staff/staff.service';
import { canAny, fecha, gated, safe } from './toolset.util';
import { ETIQUETAS_CARGO, codigoDeCargo } from '../../staff/cargos-legacy';

/**
 * Mismo gate que `StaffController` (`@RequireArea('administracion','gerencia')`): la
 * nómina no se abre por WhatsApp a quien no la ve en la web.
 */
const RRHH = [P.AREA_ADMINISTRACION, P.AREA_GERENCIA];

/**
 * Los cargos vienen de `staff/cargos-legacy.ts`, que es la única fuente.
 *
 * Estuvieron copiados aquí a propósito ("es el contrato con el modelo, hay que
 * revisarlo a conciencia y no heredarlo en silencio"), y el argumento se cayó
 * solo: la copia se desincronizó con los códigos 2 y 3 cambiados, así que a quien
 * pedía "la lista de los técnicos" el agente le entregaba las cajeras. Un contrato
 * que miente no es un contrato. Si algún día un cargo debe llamarse distinto ante
 * el modelo, se hace un alias explícito aquí — no una segunda tabla de verdad.
 */

/**
 * Empleados / RRHH para el agente interno.
 *
 * SOLO LECTURA a propósito. Crear empleados, darles acceso al sistema o cambiarles
 * permisos son operaciones con consecuencias de seguridad que se hacen mirando la
 * ficha completa, no dictando por chat: eso se queda en la web.
 *
 * Tampoco se exponen los datos sensibles que sí están en la ficha (EPS, pensión, RH,
 * dirección de la casa): por chat se resuelve "quién es, de qué área y cómo lo
 * contacto", que es la pregunta real de quien está fuera de la oficina.
 */
export class InternoRrhhToolset implements Toolset {
  constructor(private readonly staff: StaffService) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return gated(canAny(ctx, RRHH), [
      {
        name: 'buscar_empleado',
        description:
          'Lista o busca empleados de la empresa. Por nombre o documento, y —sobre todo— ' +
          'POR CARGO: usa cargo="Técnico" para "la lista de los técnicos", cargo="Cajero" para ' +
          '"las cajeras", etc. ' +
          'Úsala para "quién trabaja en…", "el teléfono de Fulano", "lista de empleados", ' +
          '"dame los técnicos activos", "cuántos empleados tenemos". ' +
          'OJO: el cargo va en el parámetro cargo, NUNCA en q — q busca por NOMBRE, así que ' +
          'q="técnico" busca a alguien que se APELLIDE técnico y no encuentra nada.',
        input_schema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Nombre o documento de UNA persona. Vacío = lista general.' },
            cargo: {
              type: 'string',
              enum: ['Cajero', 'Técnico', 'Administrativo', 'Administrador'],
              description: 'Filtra por cargo. Es lo que se usa para "la lista de los técnicos".',
            },
            // No hay filtro de estado: los inhabilitados no existen para el
            // sistema, así que todo lo que se responde por aquí es gente activa.
          },
        },
      },
      {
        name: 'ficha_empleado',
        description:
          'Ficha de un empleado: cargo, área, sede, contacto, fecha de ingreso ' +
          'y su actividad (recaudo y facturas emitidas). Necesita el id que da buscar_empleado.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'id del empleado (de buscar_empleado)' } },
          required: ['id'],
        },
      },
      {
        name: 'resumen_empleados',
        description: 'Cuántos empleados hay y cómo se reparten por cargo.',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, RRHH)) return 'PERMISO_DENEGADO';
    switch (name) {
      case 'buscar_empleado':
        return safe(() => this.buscar(input));
      case 'ficha_empleado':
        return safe(() => this.ficha(String(input.id ?? '')));
      case 'resumen_empleados':
        return safe(() => this.resumen());
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async buscar(input: Record<string, unknown>): Promise<string> {
    const cargo = codigoDeCargo(String(input.cargo ?? ''));
    if (input.cargo && cargo == null) {
      return `Ese cargo no existe. Los cargos son: ${ETIQUETAS_CARGO.join(', ')}.`;
    }

    const res: any = await this.staff.list({
      search: input.q ? String(input.q) : undefined,
      role: cargo != null ? String(cargo) : undefined,
      // Al pedir un cargo se quiere LA LISTA, no una muestra: hay 50 técnicos y 20
      // cajeros, y devolver diez con un "(+10 más; afina la búsqueda)" no se puede
      // afinar más — el criterio ya era el cargo.
      pageSize: cargo != null ? 60 : 10,
    });
    if (!res.items?.length) {
      return `No hay empleados${input.cargo ? ` con el cargo ${input.cargo}` : ''}. ` +
        `Mira los cargos que sí existen con resumen_empleados.`;
    }

    const lineas = res.items.map(
      (e: any) => `• ${e.name}${e.roleLabel ? ` — ${e.roleLabel}` : ''}${e.area ? ` (${e.area})` : ''}` +
        `${e.phone ? ` · tel ${e.phone}` : ''}\n  id: ${e.id}`,
    );
    const extra = res.total > res.items.length ? `\n(+${res.total - res.items.length} más; afina la búsqueda)` : '';
    return `${res.total} empleado(s):\n${lineas.join('\n')}${extra}`;
  }


  private async ficha(id: string): Promise<string> {
    if (!id) return 'Indica el id del empleado (búscalo primero con buscar_empleado).';
    const e: any = await this.staff.detail(id);
    // Un inhabilitado ya no es de la casa: no lo lista `buscar_empleado` y tampoco
    // se cuenta por aquí si el id llegó de una conversación vieja.
    if (e.banned) return 'Ese funcionario está inhabilitado y ya no figura en el sistema.';
    return [
      `${e.name}`,
      `Cargo: ${e.roleLabel ?? '—'}${e.area ? ` · Área: ${e.area}` : ''}`,
      e.docNumber ? `Documento: ${e.docNumber}` : '',
      [e.phone && `Tel: ${e.phone}`, e.phoneAlt && `otro: ${e.phoneAlt}`, e.email && `correo: ${e.email}`]
        .filter(Boolean).join(' · '),
      e.entryDate ? `Ingresó: ${fecha(e.entryDate)}` : '',
      e.lastLogin ? `Último ingreso al sistema: ${fecha(e.lastLogin)}` : 'Nunca ha entrado al sistema.',
      // La actividad es lo que distingue a un empleado "en los papeles" de uno que
      // realmente opera: sirve para saber a quién preguntarle por un recaudo.
      e.activity
        ? `Actividad: ${e.activity.transactions} movimiento(s) de caja y ${e.activity.invoices} factura(s) emitidas.`
        : '',
    ].filter(Boolean).join('\n');
  }

  private async resumen(): Promise<string> {
    const s: any = await this.staff.stats();
    const porCargo = Object.entries(s.roles ?? {})
      .sort((a: any, b: any) => b[1] - a[1])
      .map(([rol, n]) => `• ${rol}: ${n}`)
      .join('\n');
    return [
      `${s.total} empleados activos.`,
      porCargo ? `Por cargo:\n${porCargo}` : '',
    ].filter(Boolean).join('\n');
  }
}
