import { FieldValue, FormField } from './form-schema';

/** Los tipos de campo que se pueden pasar en un enlace. */
const CAMPOS_PARA_ENLACE = new Set([
  'text',
  'textline',
  'textarea',
  'numeric',
  'date',
  'time',
  'datetime',
  'radio',
  'checkbox',
]);

/**
 * Cambia `{CAMPO}` por el valor del campo con ese `apiId`, codificado para URL.
 *
 * Lo que no sea uno de esos campos se queda como está: se ve en la dirección, y
 * así quien diseña el formulario sabe que algo no cuadra. Un campo sin responder
 * queda vacío. El mismo criterio en el móvil (`EnlaceConValores.dart`).
 */
export function conValoresDelFormulario(
  url: string,
  campos: readonly FormField[],
  valorDe: (id: string) => FieldValue,
): string {
  if (!url.includes('{')) return url;

  const porNombre = new Map<string, FormField>();

  for (const campo of campos) {
    if (!CAMPOS_PARA_ENLACE.has(String(campo.fty ?? '').toLowerCase())) continue;
    porNombre.set(String(campo.apiId ?? '').trim() || campo.id, campo);
  }

  return url.replace(/\{([A-Za-z0-9_-]+)\}/g, (variable, nombre: string) => {
    const campo = porNombre.get(nombre);
    return campo ? encodeURIComponent(textoParaEnlace(valorDe(campo.id))) : variable;
  });
}

/** El texto de la opción en un radio; los de las opciones, con `|`, en un checkbox. */
function textoParaEnlace(valor: FieldValue): string {
  if (valor === null || valor === undefined) return '';

  if (Array.isArray(valor)) {
    return (valor as unknown[])
      .map((opcion) => textoDeOpcion(opcion))
      .filter((texto) => texto !== '')
      .join('|');
  }

  return textoDeOpcion(valor);
}

function textoDeOpcion(valor: unknown): string {
  if (valor && typeof valor === 'object') return String((valor as { txt?: unknown }).txt ?? '');
  return String(valor ?? '');
}
