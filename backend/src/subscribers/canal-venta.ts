import { BadRequestException } from '../core/http/errores';

/**
 * Tipo de venta del alta (2026-09-23): por dónde llegó el cliente. Lo elige quien
 * hace el alta y es OBLIGATORIO. Se guarda en `Subscriber.saleChannel` y, cuando el
 * tipo tiene subtipos, en `Subscriber.saleSubchannel`.
 *
 *   OFICINA
 *   REDES     → FACEBOOK | INSTAGRAM | TIKTOK
 *   REFERIDO  → FAMILIAR | AMIGO | FUNCIONARIO
 *
 * «Referido → Funcionario» reemplaza el antiguo select «Afiliado por»: el funcionario
 * elegido queda en `affiliateStaffId` (el mismo campo que lee /afiliados), con la
 * lista nominal de `AFILIADORES` (staff/afiliadores.ts).
 * En los demás tipos el cliente no queda a nombre de ningún funcionario.
 */
export const CANALES_VENTA = [
  { id: 'OFICINA', nombre: 'Oficina', subcanales: [] },
  {
    id: 'REDES',
    nombre: 'Redes sociales',
    subcanales: [
      { id: 'FACEBOOK', nombre: 'Facebook' },
      { id: 'INSTAGRAM', nombre: 'Instagram' },
      { id: 'TIKTOK', nombre: 'TikTok' },
    ],
  },
  {
    id: 'REFERIDO',
    nombre: 'Referido',
    subcanales: [
      { id: 'FAMILIAR', nombre: 'Familiar' },
      { id: 'AMIGO', nombre: 'Amigo / conocido' },
      { id: 'FUNCIONARIO', nombre: 'Funcionario' },
    ],
  },
] as const;

/** El subtipo que exige elegir al funcionario que refirió al cliente. */
export const SUBCANAL_FUNCIONARIO = 'FUNCIONARIO';

/**
 * Comprueba la combinación que llega del alta y la devuelve normalizada. Lanza 400
 * con un mensaje que se puede enseñar tal cual si falta algo o no casa.
 */
export function canalVentaValido(dto: { saleChannel?: string; saleSubchannel?: string; affiliateStaffId?: string }) {
  const canal = CANALES_VENTA.find((c) => c.id === dto.saleChannel);
  if (!canal) throw new BadRequestException('Indica el tipo de venta: Oficina, Redes sociales o Referido.');

  let subcanal: string | null = null;
  if (canal.subcanales.length) {
    const sub = canal.subcanales.find((s) => s.id === dto.saleSubchannel);
    if (!sub) {
      throw new BadRequestException(
        `Indica de dónde viene el cliente dentro de «${canal.nombre}»: ${canal.subcanales.map((s) => s.nombre).join(', ')}.`,
      );
    }
    subcanal = sub.id;
  }

  const conFuncionario = subcanal === SUBCANAL_FUNCIONARIO;
  if (conFuncionario && !dto.affiliateStaffId) {
    throw new BadRequestException('Elige el funcionario que refirió al cliente.');
  }
  return {
    saleChannel: canal.id as string,
    saleSubchannel: subcanal,
    // Sólo «Referido → Funcionario» deja al cliente a nombre de alguien.
    affiliateStaffId: conFuncionario ? dto.affiliateStaffId! : null,
  };
}
