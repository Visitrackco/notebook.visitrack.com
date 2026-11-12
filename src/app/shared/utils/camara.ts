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
import { traducir } from '../../core/i18n/idioma.service';

export function motivoSinCamara(): string {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return traducir('cam.https');
  }

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return traducir('cam.noPermite');
  }

  return '';
}

/** Traduce el error de `getUserMedia` a algo accionable. */
export function describeCameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : (error as { name?: string })?.name ?? '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return traducir('cam.sinPermiso');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return traducir('cam.noHay');
    case 'NotReadableError':
    case 'TrackStartError':
      return traducir('cam.ocupada');
    case 'SecurityError':
      return traducir('cam.bloqueada');
    default:
      return traducir('cam.noAbre');
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
