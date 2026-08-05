import { Injectable } from '@angular/core';

/**
 * Una posición capturada, en el formato que guarda la app móvil.
 *
 * Los nombres son los del servidor y **no** se traducen: la app escribe
 * exactamente estas claves y el backend las espera así. Renombrarlas aquí
 * obligaría a destraducirlas al subir.
 */
export interface GpsReading {
  lat: number;
  lng: number;
  /** Origen del dato. Siempre `'gps'`; queda por si algún día hay otro. */
  pro: string;
  /** Momento de la lectura, en milisegundos. */
  tim: number;
  /** Momento según el dispositivo. La app envía el mismo valor en ambos. */
  tph: number;
  /** Altitud en metros. 0 si el dispositivo no la da. */
  alt: number;
  /** Radio de precisión en metros. Cuanto menor, mejor. */
  acc: number;
}

/** Por qué no se pudo capturar. */
export type GpsErrorKind =
  /** El navegador no expone geolocalización. */
  | 'unsupported'
  /** La página no está en HTTPS ni en localhost. */
  | 'insecure'
  /** El usuario negó el permiso. */
  | 'denied'
  /** Hay permiso, pero no se consiguió señal. */
  | 'unavailable'
  /** Se agotó el tiempo de espera. */
  | 'timeout';

export class GpsError extends Error {
  constructor(
    readonly kind: GpsErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GpsError';
  }
}

/** Estado del permiso, cuando el navegador sabe decirlo. */
export type GpsPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * Cuánto se espera una lectura antes de rendirse.
 *
 * Un GPS recién despertado tarda: bajo techo o con el cielo tapado puede
 * necesitar más de diez segundos para fijar posición. Rendirse antes produce el
 * caso más frustrante —«no se pudo capturar» junto a una ventana con vista
 * despejada—, así que se espera holgado y se avisa mientras tanto.
 */
const TIMEOUT_MS = 20_000;

/**
 * Acceso a la ubicación del dispositivo.
 *
 * Envuelve la API del navegador para que los componentes no tengan que
 * distinguir entre sus tres códigos de error numéricos ni recordar que hace
 * falta un contexto seguro. Devuelve la lectura ya en el formato que se guarda.
 */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  /** ¿El navegador ofrece geolocalización? */
  get isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  /**
   * ¿Estamos en un contexto donde el navegador la permite?
   *
   * La geolocalización exige HTTPS. En `http://` la llamada existe pero falla
   * siempre con «permiso denegado», lo que hace pensar en un problema de
   * permisos cuando en realidad es de despliegue. `localhost` es la excepción,
   * para poder desarrollar.
   */
  get isSecureContext(): boolean {
    return typeof window !== 'undefined' && window.isSecureContext;
  }

  /**
   * Estado del permiso sin pedirlo.
   *
   * Sirve para saber si conviene explicar antes de disparar el aviso del
   * navegador. No está en todos los motores —Safari lo ignoró durante años—,
   * de ahí el `'unknown'`: quien lo reciba debe seguir adelante y dejar que el
   * navegador pregunte.
   */
  async checkPermission(): Promise<GpsPermission> {
    if (!this.isSupported) return 'denied';

    try {
      const status = await navigator.permissions?.query({ name: 'geolocation' });
      return (status?.state as GpsPermission) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Captura la posición actual.
   *
   * Lanza [GpsError] con el motivo. Se pide `enableHighAccuracy` porque el dato
   * se usa para ubicar una visita: una lectura de red con un kilómetro de error
   * no dice nada útil sobre en qué sede estuvo alguien.
   *
   * `maximumAge: 0` descarta la caché del navegador — una posición de hace una
   * hora no es dónde está el técnico ahora.
   */
  async capture(): Promise<GpsReading> {
    if (!this.isSupported) {
      throw new GpsError('unsupported', 'Este navegador no permite obtener la ubicación.');
    }

    if (!this.isSecureContext) {
      throw new GpsError(
        'insecure',
        'La ubicación solo funciona sobre una conexión segura (HTTPS).',
      );
    }

    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, (error) => reject(toGpsError(error)), {
        enableHighAccuracy: true,
        timeout: TIMEOUT_MS,
        maximumAge: 0,
      });
    });

    const timestamp = Math.round(position.timestamp || Date.now());

    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      pro: 'gps',
      tim: timestamp,
      tph: timestamp,
      // El navegador devuelve `null` cuando el dispositivo no da altitud; la
      // app móvil guarda 0 en ese caso y el backend lo espera numérico.
      alt: position.coords.altitude ?? 0,
      acc: position.coords.accuracy ?? 0,
    };
  }

  /**
   * Cómo de fiable es una lectura, para decirlo en palabras.
   *
   * El radio en metros no le dice nada a quien no trabaja con GPS; que la
   * captura sea «buena» o «aproximada» sí, y es lo que permite decidir si vale
   * la pena repetirla.
   */
  describeAccuracy(meters: number): { label: string; level: 'good' | 'fair' | 'poor' } {
    if (meters <= 15) return { label: 'Precisión buena', level: 'good' };
    if (meters <= 50) return { label: 'Precisión aceptable', level: 'fair' };
    return { label: 'Precisión baja', level: 'poor' };
  }
}

/** Traduce el error numérico del navegador a algo con nombre. */
function toGpsError(error: GeolocationPositionError): GpsError {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return new GpsError('denied', 'No se concedió el permiso de ubicación.');
    case error.POSITION_UNAVAILABLE:
      return new GpsError('unavailable', 'No se pudo determinar la ubicación.');
    case error.TIMEOUT:
      return new GpsError('timeout', 'Se agotó el tiempo esperando la señal.');
    default:
      return new GpsError('unavailable', error.message || 'Error al leer la ubicación.');
  }
}
