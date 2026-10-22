/**
 * Lo común a las pantallas que abren la cámara: la de fotografías y el
 * escáner de códigos.
 *
 * Vive aparte para que los dos digan lo mismo ante el mismo problema. Un
 * permiso negado no puede explicarse de una forma al tomar una foto y de otra
 * al escanear: quien lo lee en las dos tiene que reconocer que es lo mismo y
 * que se arregla en el mismo sitio.
 */

/**
 * ¿Se puede pedir la cámara aquí? Devuelve el motivo si no, o `''` si sí.
 *
 * Se comprueba **antes** de llamar a `getUserMedia` porque los dos casos
 * fallan de forma muda: fuera de HTTPS el navegador ni siquiera expone
 * `mediaDevices`, y el error genérico que resultaría no dice qué hacer.
 */
export function motivoSinCamara(): string {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'La cámara solo funciona en una conexión segura (HTTPS). Abre Visitrack desde su dirección https:// y vuelve a intentarlo.';
  }

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'Este navegador no permite usar la cámara.';
  }

  return '';
}

/** Traduce el error de `getUserMedia` a algo accionable. */
export function describeCameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : (error as { name?: string })?.name ?? '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'No se concedió el permiso de cámara. Habilítalo desde el icono de la barra de direcciones y vuelve a intentarlo.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No se encontró ninguna cámara en este dispositivo.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'La cámara está siendo usada por otra aplicación. Ciérrala e inténtalo de nuevo.';
    case 'SecurityError':
      return 'El navegador bloqueó la cámara en esta página. Comprueba que esté en HTTPS y que el sitio tenga permiso.';
    default:
      return 'No se pudo abrir la cámara. Comprueba que la página esté en HTTPS.';
  }
}

/**
 * Apaga una captura.
 *
 * Cada pista hay que pararla explícitamente: sin esto el piloto sigue
 * encendido después de cerrar, y no hay forma de que el usuario sepa que ya no
 * se está grabando nada.
 */
export function detenerCaptura(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
