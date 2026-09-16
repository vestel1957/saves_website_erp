/**
 * El COMENTARIO DE RED del abonado (`customers.comentario` del legacy, aquí
 * `Subscriber.netComment`) y la VLAN que lleva dentro.
 *
 * Es el comentario del secret de Mikrotik, y el legacy lo escribe siempre con la
 * misma receta: barrio, número de abonado, VLAN y tecnología. Ejemplos reales:
 *
 *     CENTRO COMERCIAL EL HOBO 57517 VLAN 290 FTTH
 *     PALMARES 57514  vlan 430 ftth
 *     ALGARROBO 57509 EPON
 *
 * No es adorno: es el único sitio donde queda escrita la VLAN por la que navega
 * ese cliente. El catálogo `Vlan` describe las VLAN de la red (sede, OLT,
 * bandeja, puerto), pero NADA ata un abonado a una de ellas salvo este texto, y
 * el mismo número de VLAN se repite en varias sedes, así que ni siquiera se
 * puede deducir por el número. De ahí que la ficha muestre el comentario tal
 * cual —lo escribió una persona y puede traer cosas que la receta no prevé— y
 * además saque la VLAN aparte, que es lo que se busca al abrirla.
 *
 * De 21.872 abonados, 10.747 tienen comentario y 7.118 nombran la VLAN.
 */

/**
 * Número de VLAN escrito en el comentario, o null si no lo nombra.
 *
 * Se lee lo que va DESPUÉS de la palabra 'vlan' porque antes está el número de
 * abonado, que es el que se colaría si se buscara "el primer número". Entre
 * medias se toleran unos pocos caracteres para las variantes de captura —'VLAN
 * FTTH 310', 'VLAN  500', 'vlan: 70'—, pero no tantos como para engancharse a un
 * número de otra parte del texto: 'VILLA LUCIA 3362 VLAN -- FTTH' se queda sin
 * VLAN, que es lo correcto.
 */
export function vlanDeComentario(comentario: string | null | undefined): number | null {
  if (!comentario) return null;
  const m = /vlan[^0-9]{0,10}([0-9]{1,4})/i.exec(comentario);
  if (!m) return null;
  const n = Number(m[1]);
  // 0 y 4095 están reservadas en 802.1Q; fuera de rango es un error de captura.
  return n > 0 && n < 4095 ? n : null;
}

/**
 * Devuelve el comentario con la VLAN cambiada a `vlan` (o quitada si es null).
 *
 * La VLAN no tiene columna propia: vive DENTRO de este texto (ver arriba), así que
 * editarla es reescribir el comentario. Tres casos, en el orden en que se dan:
 *
 *  · el comentario ya la nombra  → se cambia el número EN SU SITIO, sin tocar el
 *    resto («MIRADOR 54519 VLAN 200 FTTH» → «… VLAN 340 FTTH»). Se conserva la
 *    palabra tal como estaba escrita ('VLAN', 'vlan', 'Vlan:').
 *  · no la nombra                → se añade «VLAN n» ANTES de la tecnología final
 *    (FTTH/EPON/GPON), que es donde la pone la receta del legacy; si no hay
 *    tecnología, al final.
 *  · vlan = null                 → se borra la mención entera y se recomponen los
 *    espacios, para no dejar «MIRADOR 54519  FTTH» con el hueco.
 *
 * Ojo con lo que ESTO NO HACE: es el dato apuntado, no la red. La VLAN por la que
 * navega de verdad el abonado la fija el service-port de la OLT; cambiar el
 * comentario corrige la ficha (y el legacy, por el writeback), no el tráfico.
 */
export function conVlanEnComentario(
  comentario: string | null | undefined,
  vlan: number | null,
): string | null {
  const base = (comentario ?? '').trim();
  // Misma expresión que `vlanDeComentario`, pero partida para poder reescribir sólo
  // el número: si las dos se separan, una lee una VLAN que la otra no sabe cambiar.
  const re = /(vlan[^0-9]{0,10})([0-9]{1,4})/i;

  if (vlan == null) {
    if (!base) return null;
    // Se quita también la palabra: dejar 'VLAN' suelta haría que la ficha siguiera
    // pareciendo que hay una VLAN escrita pero ilegible.
    return base.replace(re, ' ').replace(/\s{2,}/g, ' ').trim() || null;
  }

  if (re.test(base)) return base.replace(re, (_m, palabra: string) => `${palabra}${vlan}`);

  const tecnologia = /\b(ftth|epon|gpon)\b\s*$/i.exec(base);
  if (tecnologia) {
    return `${base.slice(0, tecnologia.index).trim()} VLAN ${vlan} ${tecnologia[1]}`.trim();
  }
  return base ? `${base} VLAN ${vlan}` : `VLAN ${vlan}`;
}
