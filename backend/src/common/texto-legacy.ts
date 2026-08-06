/**
 * Texto plano a partir de lo que guardó el legacy.
 *
 * El legacy editaba las notas de una orden con un WYSIWYG, así que en la base
 * hay marcas crudas: `<p>Cambiar conector mecanico</p>`, `Daño cajas nap&nbsp;`.
 * Eso NO se puede pintar como HTML (sería XSS almacenado sobre datos heredados
 * que nadie revisó), pero pintarlo tal cual —que es lo que se hacía— le enseña
 * al técnico las etiquetas en pantalla.
 *
 * Aquí se quita el marcado y se traducen las entidades que de verdad aparecen en
 * los datos, incluidas las numéricas (el legacy escribía `&#241;` por la ñ).
 */
const ENTIDADES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  deg: '°', hellip: '…', laquo: '«', raquo: '»',
};

export function textoPlano(s: string | null | undefined): string | null {
  if (s == null) return null;
  const limpio = s
    // Los saltos del editor se conservan como saltos de verdad: la nota del
    // técnico suele venir en renglones y aplanarla a una línea la vuelve ilegible.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&([a-zA-Z]+);/g, (m, e: string) => ENTIDADES[e] ?? m)
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
  return limpio || null;
}
