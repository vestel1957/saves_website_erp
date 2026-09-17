/**
 * Soluciones / causas con las que se documenta una orden (migradas del select del
 * legacy `tickets/thread`). Es la MISMA lista del formulario «Documentar» de la web
 * (`frontend/src/app/soporte/[id]/page.tsx`) y de la app móvil: si se agrega una allá,
 * se agrega aquí, o el cierre rechazaría una orden bien documentada.
 */
export const SOLUCIONES = [
  'Cablemoden desconfigurado', 'Mantenimiento a la Red', 'Cambio de Tecnologia', 'Fusiono Fibra',
  'Cambio de Fibra', 'Cambio de Cable RG 6', 'Reestructuracion Red', 'Instalo Caja NAP',
  'Instalaciones Internas en Mal estado', 'Manipulacion del Usuario', 'Daño General', 'Sin energia el Sector',
  'Elementos Quemados', 'Internet lento', 'No aparece la Red', 'No prende Cablemoden', 'Fibra Rota',
  'Cable Caido', 'ONU alarmada', 'Desconfigurado Cablemoden', 'No hay Internet',
  'Fallo Causado por Proveedor de Servicio', 'Fallo en centro de datos principal', 'Baja cobertura wifi interna',
  'Cambio de conectores mecánicos', 'Cambio de equipo por daño', 'Cambio de Patch Cord de fibra',
  'Cambio de tendido de fibra óptica', 'Condiciones de equipo final fuera de parámetros de operación',
  'Configuración de red lan del cliente', 'Entrega de servicio a satisfacción', 'Equipo de cliente final por defecto',
  'Habilitación de servicio de internet', 'Habilitación de servicio de televisión', 'Mantenimiento Correctivo de red',
  'Mejoramiento de infraestructura de red', 'Migración de Tecnología', 'Retiro de equipos de comunicaciones',
  'Revisión de red interna del cliente', 'Suministro de equipos o material', 'Traslado de equipos por cambio de vivienda',
  'Traslado interno de equipos de red en cliente final', 'Viabilidad y/o levantamiento técnico',
  'Punto de distribución de red intermitente o in-operativo',
] as const;

const normal = (s: string) => s.trim().toLowerCase();
const CONOCIDAS = new Set(SOLUCIONES.map(normal));

/**
 * Separa un renglón del seguimiento en solución y detalle. Al documentar se guarda
 * `"<solución>/ <detalle>"` (formato del legacy). Si lo de antes de la barra no es
 * una solución de la lista, no hay solución: todo es detalle.
 */
export function partirDocumentacion(msg: string | null | undefined): { solucion: string | null; detalle: string } {
  const m = (msg ?? '').trim();
  const i = m.indexOf('/');
  if (i > 0 && CONOCIDAS.has(normal(m.slice(0, i)))) {
    return { solucion: m.slice(0, i).trim(), detalle: m.slice(i + 1).trim() };
  }
  return { solucion: null, detalle: m };
}
