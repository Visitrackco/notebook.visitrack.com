/**
 * El reconocedor de códigos: quién mira cada fotograma y dice qué código hay.
 *
 * ## Dos motores, y por qué
 *
 * - **`BarcodeDetector`**, el del navegador. Es nativo —en Android se apoya en
 *   el mismo servicio que usan las apps de Google—, rápido y no pesa nada. Pero
 *   no está en todas partes: Chrome lo trae en Android, macOS y ChromeOS, no en
 *   Windows ni en Linux, y Firefox y Safari no lo exponen.
 * - **ZXing** (`@zxing/browser`), en JavaScript. Funciona en cualquier
 *   navegador con cámara, a costa de unos cientos de kilobytes y de más
 *   trabajo por fotograma.
 *
 * Se usa el nativo cuando existe **y** reconoce todos los formatos que se le
 * piden; si le falta alguno, ZXing. Mezclar —nativo para unos y ZXing para
 * otros— obligaría a pasar cada fotograma por los dos, y para eso basta ZXing.
 *
 * ZXing se carga con `import()` solo al abrir el escáner: casi ninguna sesión
 * escanea, y meterlo en el arranque haría pagar a todas lo que usan unas pocas.
 */

/**
 * Los formatos que se leen, con su nombre en `BarcodeDetector`.
 *
 * Los mismos que acepta el móvil (`mobile_scanner` lee todos): QR y Data
 * Matrix para lo cuadrado, el resto para lo lineal y el PDF417 de las cédulas.
 * El modo del escáner (QR o barras) cambia la forma del recuadro, no lo que se
 * reconoce: quien apunta a un código de barras con el modo QR puesto lo lee
 * igual, como en el teléfono.
 */
export const FORMATOS = [
  'qr_code',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'itf',
  'codabar',
  'data_matrix',
  'pdf417',
] as const;

export type Formato = (typeof FORMATOS)[number];

/** Lo que se leyó. */
export interface Lectura {
  texto: string;
  formato: string;
}

/** Un reconocedor listo para usar. */
export interface LectorDeCodigos {
  motor: 'nativo' | 'zxing';
  /** Busca un código en la imagen. `null` si no hay ninguno legible. */
  leer(imagen: HTMLCanvasElement): Promise<Lectura | null>;
}

/** Lo mínimo de `BarcodeDetector`, que el `lib.dom` de TypeScript no trae. */
interface DetectorNativo {
  detect(imagen: CanvasImageSource): Promise<{ rawValue: string; format: string }[]>;
}

interface ConstructorDetectorNativo {
  new (opciones?: { formats?: string[] }): DetectorNativo;
  getSupportedFormats?(): Promise<string[]>;
}

/**
 * Crea el reconocedor que toque en este navegador.
 *
 * @throws si no hay `BarcodeDetector` útil y ZXing no se pudo cargar —p. ej.
 *   sin conexión y con el fragmento todavía sin descargar—. Quien llama lo
 *   enseña como «el lector no está disponible» y ofrece escribir a mano.
 */
export async function crearLector(): Promise<LectorDeCodigos> {
  const nativo = await crearNativo();
  return nativo ?? crearZxing();
}

async function crearNativo(): Promise<LectorDeCodigos | null> {
  const Detector = (globalThis as { BarcodeDetector?: ConstructorDetectorNativo }).BarcodeDetector;
  if (!Detector) return null;

  try {
    // Hay navegadores que exponen la clase pero sin ningún formato detrás
    // (Chrome en un escritorio sin el servicio): cuenta como que no está.
    const soportados = (await Detector.getSupportedFormats?.()) ?? [];
    if (!FORMATOS.every((formato) => soportados.includes(formato))) return null;

    const detector = new Detector({ formats: [...FORMATOS] });

    return {
      motor: 'nativo',
      async leer(imagen) {
        const hallados = await detector.detect(imagen);
        const primero = hallados.find((codigo) => Boolean(codigo.rawValue));
        return primero ? { texto: primero.rawValue, formato: primero.format } : null;
      },
    };
  } catch {
    return null;
  }
}

async function crearZxing(): Promise<LectorDeCodigos> {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library'),
  ]);

  const formatos = [
    BarcodeFormat.QR_CODE,
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.CODE_93,
    BarcodeFormat.ITF,
    BarcodeFormat.CODABAR,
    BarcodeFormat.DATA_MATRIX,
    BarcodeFormat.PDF_417,
  ];

  const pistas = new Map<number, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, formatos],
    // Más lento por fotograma, pero lee códigos inclinados o con poca luz, que
    // es como llegan desde una cámara web sostenida a mano.
    [DecodeHintType.TRY_HARDER, true],
  ]);

  const lector = new BrowserMultiFormatReader(pistas);

  return {
    motor: 'zxing',
    async leer(imagen) {
      try {
        const resultado = lector.decodeFromCanvas(imagen);
        const texto = resultado.getText();
        return texto ? { texto, formato: BarcodeFormat[resultado.getBarcodeFormat()] ?? '' } : null;
      } catch {
        // ZXing avisa de «no hay código» lanzando una excepción: en un
        // fotograma sin código es lo normal, no un error.
        return null;
      }
    },
  };
}
