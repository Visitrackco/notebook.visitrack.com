/**
 * Qué archivos se admiten en un campo de adjunto.
 *
 * ## Por qué una lista blanca y no una negra
 *
 * Enumerar lo prohibido es una carrera perdida: hay cientos de extensiones
 * ejecutables y cada sistema añade las suyas. Enumerar lo permitido acota el
 * problema a lo que este formulario necesita de verdad —una foto, una hoja de
 * cálculo, un PDF— y todo lo demás queda fuera sin tener que preverlo.
 *
 * ## Esto no es seguridad, es higiene
 *
 * La comprobación vive en el navegador, así que cualquiera con las
 * herramientas de desarrollo puede saltársela. Sirve para lo que pasa de
 * verdad: que alguien adjunte por error un instalador de 400 MB, o un archivo
 * que el servidor no va a saber procesar. **La validación que protege es la del
 * servidor**, y esta no la sustituye.
 */

/** Extensiones admitidas, agrupadas por familia. */
const ALLOWED: Record<string, readonly string[]> = {
  /** Lo que sale de una cámara o de una captura de pantalla. */
  imagen: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff'],

  documento: ['pdf'],

  /** Office y su equivalente libre, que en campo también aparece. */
  ofimática: [
    'doc',
    'docx',
    'xls',
    'xlsx',
    'xlsm',
    'xlsb',
    'ppt',
    'pptx',
    'csv',
    'txt',
    'rtf',
    'odt',
    'ods',
    'odp',
  ],
};

/** Todas las extensiones admitidas, en una lista. */
export const ALLOWED_EXTENSIONS: readonly string[] = Object.values(ALLOWED).flat();

/**
 * Tope de tamaño, en bytes.
 *
 * Cien megabytes. El archivo se guarda en el navegador y después tiene que
 * subirse desde donde esté el usuario, que a menudo es una conexión móvil con
 * mala cobertura: algo más grande no llega nunca y deja la actividad detenida
 * esperándolo.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Valor del atributo `accept` del selector de archivos.
 *
 * Filtra lo que el explorador del sistema ofrece. Es comodidad, no control: el
 * usuario puede cambiar el filtro a «todos los archivos», y por eso la
 * comprobación de verdad se hace igualmente al recibirlo.
 */
export const FILE_ACCEPT = ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** Resultado de revisar un archivo. */
export interface FileCheck {
  ok: boolean;
  /** Extensión en minúsculas, sin punto. */
  ext: string;
  /** Motivo del rechazo, listo para mostrar. */
  error?: string;
}

/**
 * ¿Se puede adjuntar este archivo?
 *
 * Comprueba tres cosas, en el orden en que fallan más a menudo: que tenga una
 * extensión reconocible, que esa extensión esté admitida y que no se pase de
 * tamaño.
 */
export function checkFile(file: File): FileCheck {
  const ext = extensionOf(file.name);

  if (!ext) {
    return {
      ok: false,
      ext: '',
      error: 'El archivo no tiene extensión, así que no se puede comprobar qué es.',
    };
  }

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      ext,
      error:
        `Los archivos «.${ext}» no se admiten. ` +
        'Solo se pueden adjuntar imágenes, PDF y documentos de Office.',
    };
  }

  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      ext,
      error: `El archivo pesa ${formatSize(file.size)} y el máximo son 100 MB.`,
    };
  }

  if (file.size === 0) {
    return { ok: false, ext, error: 'El archivo está vacío.' };
  }

  return { ok: true, ext };
}

/**
 * La extensión real del archivo.
 *
 * Se toma **la última**, que es la que decide cómo lo trata un sistema: un
 * `informe.pdf.exe` es un ejecutable, no un PDF, y quedarse con la primera
 * extensión es justo el truco con el que se cuelan.
 */
export function extensionOf(name: string): string {
  const clean = (name ?? '').trim().toLowerCase();
  const dot = clean.lastIndexOf('.');

  if (dot < 0 || dot === clean.length - 1) return '';

  // Se descarta lo que no sean letras y números: hay nombres con caracteres de
  // control detrás del punto para disimular la extensión verdadera.
  const ext = clean.slice(dot + 1);
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** Tamaño legible. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
