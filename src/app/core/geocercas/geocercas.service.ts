import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { environment } from '../../../environments/environment';
import { resolveCatalogOwnerId } from '../config/company-rules';
import { DatabaseService } from '../database/database.service';
import { LocationRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ActivityService } from '../services/activity.service';
import { AuthService } from '../services/auth.service';
import { ConnectivityService } from '../services/connectivity.service';
import { ToastService } from '../services/toast.service';
import { SyncService } from '../sync/sync.service';
import { nuevoGuid } from '../../shared/utils/guid';
import { MomentosDeLaAppService } from './momentos-de-la-app.service';
import {
  AccionDeRegla,
  ContextoDeMomento,
  Disparo,
  EstadoDeVigia,
  Lectura,
  MomentoDeLaApp,
  MomentosDeGeocerca,
  VigiaDeGeocercas,
} from './vigia-de-geocercas';

/** Lecturas con peor precisión se descartan, como `PRECISION_MAXIMA` en el teléfono. */
const PRECISION_MAXIMA = 200;

/**
 * Cada cuánto se evalúa una lectura, como el `CADA_MS` del servicio nativo.
 *
 * `watchPosition` puede dar una lectura por segundo; evaluarlas todas haría que
 * las «dos lecturas para confirmar un cruce» pasaran en dos segundos en vez de
 * en unos cuarenta, y el freno contra el salto del GPS dejaría de servir. Y al
 * revés: quieto delante del escritorio el navegador puede no dar ninguna, y
 * «al quedarse» no llegaría nunca. Por eso se evalúa a este ritmo la última
 * lectura buena, llegue o no una nueva.
 */
const CADA_MS = 20_000;

/** Una lectura más vieja que esto ya no dice dónde está la persona. */
const LECTURA_VIGENTE_MS = 2 * 60_000;

/** Cada cuánto se reintenta contar lo pendiente, como `SUBIR_CADA_MS`. */
const SUBIR_CADA_MS = 2 * 60_000;

const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;

/** En qué anda la vigilancia, para el indicador del armazón. */
export type EstadoDeGeocercas = 'apagada' | 'vigilando' | 'sin-permiso' | 'sin-gps';

/** Un evento en la cola, como la tabla `eventos` de `geocercas_nativo.db`. */
interface EventoEnCola {
  ID?: number;
  UserID: string;
  Clave: string;
  /** Lo que se le manda a cloud-gold, tal cual. */
  Payload: Record<string, unknown>;
  Enviado: 0 | 1;
  Creado: number;
}

/**
 * Los flujos de geocerca en la web.
 *
 * ## Solo con la pestaña abierta
 *
 * En el teléfono los vigila un servicio nativo que sigue leyendo el GPS con la
 * app cerrada. En el navegador eso no existe: ni un service worker puede leer
 * la ubicación. Aquí se vigila **mientras haya una pestaña de Visitrack
 * abierta** (aunque esté en segundo plano, el navegador la ralentiza pero suele
 * seguir dando lecturas). Cerrada la pestaña, no hay vigilancia; al volver a
 * abrirla, el estado guardado evita que la recarga cuente como «entrar».
 *
 * ## Qué hace con cada disparo (igual que el teléfono)
 *
 * 1. Lo guarda en `EventosGeocerca` y se lo cuenta a cloud-gold
 *    (`/geofence-flows/eventos`), que hace lo que necesita red —correo,
 *    alerta, chat— y lo pinta en el mapa. Lo que no llegó se reintenta.
 * 2. Muestra las notificaciones de la regla (`notificar`) con la API de
 *    notificaciones si hay permiso; si no, con un aviso dentro de la app.
 * 3. Crea las actividades que pida (`crear-actividad`), en la base local.
 *
 * Se enciende sola con la sesión, se recarga al terminar cada sincronización
 * y se apaga al cerrar sesión. El permiso de ubicación solo se pide si hay
 * algún flujo activo.
 */
@Injectable({ providedIn: 'root' })
export class GeocercasService {
  private readonly auth = inject(AuthService);
  private readonly db = inject(DatabaseService);
  private readonly sync = inject(SyncService);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly activities = inject(ActivityService);
  private readonly locations = inject(LocationRepository);
  private readonly toasts = inject(ToastService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly router = inject(Router);
  private readonly bus = inject(MomentosDeLaAppService);

  /** Cuántos flujos activos se están vigilando. */
  readonly flujosActivos = signal(0);

  /** En qué anda la vigilancia. */
  readonly estado = signal<EstadoDeGeocercas>('apagada');

  /** Si el indicador del armazón tiene algo que decir. */
  readonly visible = computed(() => this.estado() !== 'apagada');

  private vigia: VigiaDeGeocercas | null = null;
  private momentos: MomentosDeGeocerca | null = null;
  private usuario = '';
  private watchId: number | null = null;
  private pulso: ReturnType<typeof setInterval> | null = null;
  private subida: ReturnType<typeof setInterval> | null = null;
  private ultima: { lat: number; lng: number; en: number } | null = null;
  private ultimaEvaluada = 0;
  private subiendo = false;
  private generacion = 0;

  constructor() {
    // Con sesión se enciende; sin ella, se apaga. Cubre iniciar sesión,
    // cambiar de cuenta, «entrar como» y cerrar sesión.
    effect(() => {
      const user = this.auth.currentUser();
      const id = user?.UserID ?? '';
      untracked(() => {
        if (!id) void this.apagar();
        else if (id !== this.usuario) void this.recargar();
      });
    });

    // Al terminar cada sincronización: pudieron llegar, cambiar o borrarse flujos.
    const fase = computed(() => this.sync.state().phase);
    effect(() => {
      if (fase() !== 'done') return;
      untracked(() => void this.recargar());
    });

    // Al volver la red, se cuenta lo que quedó pendiente.
    effect(() => {
      if (!this.connectivity.browserOnline()) return;
      untracked(() => void this.subirEventos());
    });

    // Los momentos de la app: crear, guardar, eliminar, iniciar y cerrar sesión.
    this.bus.escuchar((momento, contexto, espera) => this.momento(momento, contexto, espera));
  }

  /** Lee los flujos activos de quien tiene la sesión y enciende o apaga la vigilancia. */
  async recargar(): Promise<void> {
    const user = this.auth.currentUser();
    if (!user) {
      await this.apagar();
      return;
    }

    const generacion = ++this.generacion;
    const flujos = await this.flujosActivosDe(resolveCatalogOwnerId(user));
    if (generacion !== this.generacion) return;

    // Otra persona en el mismo navegador: su vigía, con su propio estado.
    if (this.usuario !== user.UserID || !this.vigia) {
      this.detenerGps();
      this.usuario = user.UserID;
      this.vigia = new VigiaDeGeocercas(this.leerEstado(user.UserID), (e) =>
        this.guardarEstado(user.UserID, e),
      );
      // Los momentos llevan su propio estado de «una vez al día».
      this.momentos = new MomentosDeGeocerca(this.leerEstado(user.UserID, 'momentos'), (e) =>
        this.guardarEstado(user.UserID, e, 'momentos'),
      );
    }

    this.vigia.cargar(flujos);
    this.flujosActivos.set(flujos.length);

    if (this.vigia.hayAlgo()) this.encenderGps();
    else {
      this.detenerGps();
      this.estado.set('apagada');
    }

    void this.subirEventos();
  }

  /** Al cerrar sesión: nada que vigilar para nadie. */
  async apagar(): Promise<void> {
    this.generacion++;
    this.detenerGps();
    this.vigia = null;
    this.momentos = null;
    this.usuario = '';
    this.flujosActivos.set(0);
    this.estado.set('apagada');
  }

  /**
   * Los `JSONMovil` de los flujos encendidos de quien tiene la sesión. Es
   * `flujosDeGeocercaActivos` del móvil.
   */
  private async flujosActivosDe(ownerId: number): Promise<string[]> {
    try {
      const filas = await this.db.transaction<any[]>('FlujosGeocerca', 'readonly', (tx) =>
        this.db.request<any[]>(tx.objectStore('FlujosGeocerca').index('byUserID').getAll(ownerId)),
      );
      return filas
        .filter((f) => Number(f?.IsActive) === 1 && Number(f?.IsDeleted) !== 1)
        .map((f) => String(f?.JSONMovil ?? ''))
        .filter((j) => j.length > 0);
    } catch (error) {
      console.warn('[Geocercas] no se pudieron leer los flujos', error);
      return [];
    }
  }

  // ─── El GPS ────────────────────────────────────────────────────────────────

  private encenderGps(): void {
    if (this.watchId !== null) return;

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.estado.set('sin-gps');
      return;
    }

    this.estado.set('vigilando');

    // Aquí, y solo aquí, el navegador pide el permiso: hay flujos que vigilar.
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.alLlegar(pos),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          this.estado.set('sin-permiso');
          this.detenerGps(false);
        }
        // Sin señal o fuera de tiempo: se sigue esperando la próxima.
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 60_000 },
    );

    this.pulso = setInterval(() => this.evaluarUltima(), CADA_MS);
    this.subida = setInterval(() => void this.subirEventos(), SUBIR_CADA_MS);
  }

  private detenerGps(reiniciarEstado = true): void {
    if (this.watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
    if (this.pulso) clearInterval(this.pulso);
    if (this.subida) clearInterval(this.subida);
    this.pulso = null;
    this.subida = null;
    this.ultima = null;
    this.ultimaEvaluada = 0;
    if (reiniciarEstado && this.estado() !== 'apagada') this.estado.set('apagada');
  }

  private alLlegar(pos: GeolocationPosition): void {
    const { latitude, longitude, accuracy } = pos.coords;
    if (Number.isFinite(accuracy) && accuracy > PRECISION_MAXIMA) return;

    if (this.estado() !== 'vigilando') this.estado.set('vigilando');
    this.ultima = { lat: latitude, lng: longitude, en: Date.now() };

    if (Date.now() - this.ultimaEvaluada >= CADA_MS / 2) this.evaluarUltima();
  }

  private evaluarUltima(): void {
    const lectura = this.ultima;
    const vigia = this.vigia;
    if (!lectura || !vigia) return;

    const ahora = Date.now();
    if (ahora - lectura.en > LECTURA_VIGENTE_MS) return;
    if (ahora - this.ultimaEvaluada < CADA_MS / 2) return;
    this.ultimaEvaluada = ahora;

    let disparos: Disparo[] = [];
    try {
      disparos = vigia.evaluar({ lat: lectura.lat, lng: lectura.lng }, ahora);
    } catch (error) {
      console.warn('[Geocercas] la vigía falló con esta lectura', error);
    }
    if (disparos.length) void this.procesar(disparos);
  }

  // ─── Lo que pasa con cada disparo ─────────────────────────────────────────

  /**
   * Notificar en el acto, guardar para contar, crear actividades. Es
   * `revisarGeocercas` del servicio nativo más `procesarPendientes` de Dart.
   */
  private async procesar(disparos: Disparo[]): Promise<void> {
    const user = this.auth.currentUser();
    if (!user) return;
    if (!disparos.length) return;

    for (const d of disparos) {
      const clave = await this.guardarEvento(user.UserID, d);
      this.notificar(d, clave);

      for (const a of d.acciones) {
        if (a.accion === 'crear-actividad') {
          try {
            await this.crearActividad(a, d);
          } catch (error) {
            console.warn('[Geocercas] no se pudo crear la actividad', error);
          }
        }
      }
    }

    // Esperado y no suelto: el cierre de sesión necesita saber que ya se contó.
    await this.subirEventos();
  }

  // ─── Momentos de la app ───────────────────────────────────────────────────

  /**
   * Evalúa las reglas de un momento de la app con **una** lectura fresca.
   *
   * Sin dos lecturas ni «la primera aprende»: ver [MomentosDeGeocerca]. Si no
   * hay ubicación —ni fresca ni una de la vigilancia de menos de dos minutos—
   * no se dispara, y se deja dicho en la consola.
   */
  async momento(
    momento: MomentoDeLaApp,
    contexto: ContextoDeMomento | null,
    esperaGpsMs = 10_000,
  ): Promise<void> {
    // En la web no hay recorrido.
    if (momento.startsWith('recorrido-')) return;

    const user = this.auth.currentUser();
    if (!user) return;
    // Recién iniciada la sesión, la recarga del efecto puede ir en paralelo y
    // abortar esta: se insiste un par de veces hasta tener los flujos de quien es.
    for (let i = 0; i < 3 && (!this.vigia || !this.momentos || this.usuario !== user.UserID); i++) {
      await this.recargar();
    }

    const vigia = this.vigia;
    const momentos = this.momentos;
    if (!vigia || !momentos) return;

    const flujos = vigia.flujosCargados;
    if (!MomentosDeGeocerca.hayReglaPara(flujos, momento)) return;

    const lectura = await this.lecturaFresca(esperaGpsMs);
    if (!lectura) {
      console.info(
        `[Geocercas] «${momento}» no se evaluó: no hay una ubicación fresca ni una reciente (menos de 2 min).`,
      );
      return;
    }

    let disparos: Disparo[] = [];
    try {
      disparos = momentos.evaluar(flujos, momento, contexto, lectura);
    } catch (error) {
      console.warn(`[Geocercas] «${momento}» no se pudo evaluar`, error);
    }
    await this.procesar(disparos);
  }

  /**
   * Una lectura en el momento (alta precisión). Si falla o es imprecisa, la
   * última de la vigilancia si tiene menos de dos minutos; si no, `null`.
   */
  private lecturaFresca(timeoutMs: number): Promise<Lectura | null> {
    const respaldo = (): Lectura | null => {
      const u = this.ultima;
      return u && Date.now() - u.en <= LECTURA_VIGENTE_MS ? { lat: u.lat, lng: u.lng } : null;
    };

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return Promise.resolve(respaldo());
    }

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          if (Number.isFinite(accuracy) && accuracy > PRECISION_MAXIMA) resolve(respaldo());
          else resolve({ lat: latitude, lng: longitude });
        },
        () => resolve(respaldo()),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
      );
    });
  }

  /** Guarda el disparo y devuelve su clave: con ella se abre su pantalla. */
  private async guardarEvento(userId: string, d: Disparo): Promise<string> {
    const clave = nuevoGuid();
    const evento: EventoEnCola = {
      UserID: userId,
      Clave: clave,
      Payload: {
        clave,
        flujoId: d.flujoId,
        reglaId: d.reglaId,
        geocercaId: d.geocercaId,
        punto: d.punto,
        tipo: d.tipo,
        lat: d.lat,
        lng: d.lng,
        en: new Date(d.en).toISOString(),
        // Los de momento dicen cuál y de qué actividad.
        ...(d.tipo === 'MOMENTO'
          ? {
              momento: d.momento ?? '',
              contexto: d.contexto
                ? { answerGuid: d.contexto.answerGuid, surveyId: Number(d.contexto.surveyId) || null }
                : null,
            }
          : {}),
      },
      Enviado: 0,
      Creado: Date.now(),
    };

    try {
      await this.db.transaction('EventosGeocerca', 'readwrite', (tx) =>
        this.db.request(tx.objectStore('EventosGeocerca').add(evento)),
      );
    } catch (error) {
      console.warn('[Geocercas] no se pudo guardar el evento', error);
    }
    return clave;
  }

  /**
   * Las notificaciones de la regla, sin red.
   *
   * Con permiso, la del sistema —también con la pestaña a la vista, como en el
   * teléfono—; sin permiso, o si el navegador no la deja crear desde la página,
   * un aviso dentro de la aplicación. Aquí no se pide el permiso: el navegador
   * solo lo concede tras un clic, y para eso está la tira del armazón.
   *
   * Tocar la notificación —o «Ver» en el aviso— lleva a la pantalla del
   * evento (`geocerca-evento/:clave`), con el título y el texto de la alerta.
   */
  private notificar(d: Disparo, clave: string): void {
    d.acciones.forEach((a, i) => {
      if (a.accion !== 'notificar') return;

      const titulo = this.rellenar(String(a['titulo'] ?? ''), d) || 'Geocerca';
      const texto = this.rellenar(String(a['texto'] ?? ''), d);
      const ver = () =>
        void this.router.navigate(['/geocerca-evento', clave], {
          queryParams: { titulo, texto: texto || null },
        });

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const aviso = new Notification(titulo, {
            body: texto,
            icon: '/favicon.ico',
            tag: `vt-geocerca-${d.en}-${i}`,
          });
          aviso.onclick = () => {
            window.focus();
            aviso.close();
            ver();
          };
          return;
        } catch {
          // Algunos navegadores solo las crean desde el service worker: queda el aviso de dentro.
        }
      }

      this.toasts.show({
        title: titulo,
        detail: texto,
        tone: 'info',
        icon: 'map-pin',
        duration: 0,
        action: { label: 'Ver', run: ver },
      });
    });
  }

  /** Las mismas variables que entiende el servidor (y el teléfono). */
  private rellenar(texto: string, d: Disparo): string {
    const user = this.auth.currentUser();
    const fecha = new Date(d.en);
    const dd = (n: number) => String(n).padStart(2, '0');
    const valores: Record<string, string> = {
      '{USUARIO}': `${user?.FirstName ?? ''} ${user?.LastName ?? ''}`.trim(),
      '{GEOCERCA}': d.geocercaNombre,
      '{PUNTO}': d.puntoNombre,
      '{FECHA}': `${dd(fecha.getDate())}/${dd(fecha.getMonth() + 1)}/${fecha.getFullYear()}`,
      '{HORA}': `${dd(fecha.getHours())}:${dd(fecha.getMinutes())}`,
      '{MAPA}': `https://maps.google.com/?q=${d.lat.toFixed(6)},${d.lng.toFixed(6)}`,
    };
    let salida = texto;
    for (const [variable, valor] of Object.entries(valores)) {
      salida = salida.replace(new RegExp(variable.replace(/[{}]/g, '\\$&'), 'gi'), valor);
    }
    return salida;
  }

  /**
   * Crea una actividad del formulario que dijo la regla, sin borrador: es
   * trabajo pendiente que aparece en el listado, como una consigna. Es
   * `GeocercaService._crearActividad` del móvil.
   *
   * Si la regla lo pide y el punto donde pasó es una **ubicación**, la
   * actividad nace en esa sede — pero solo si el formulario es de ese tipo de
   * ubicación. Una sede de otro tipo en un formulario que no la espera la
   * dejaría imposible de diligenciar.
   */
  private async crearActividad(a: AccionDeRegla, d: Disparo): Promise<void> {
    const surveyId = String(a['surveyId'] ?? '');
    if (!surveyId || surveyId === '0') return;

    const user = this.auth.currentUser();
    if (!user) return;

    const survey = await this.activities.findSurvey(surveyId);
    if (!survey) {
      console.warn('[Geocercas] la regla pidió un formulario que no está descargado', surveyId);
      return;
    }

    const nueva = await this.answers.createDraft({
      survey,
      userId: user.UserID,
      companyId: user.CompanyID,
    });
    if (nueva.ID == null) return;

    // No nace como borrador: la limpieza de borradores se la llevaría.
    await this.answers.update(nueva.ID, { eraser: 0 });

    const punto = d.punto ?? '';
    if (a['enElPunto'] !== false && punto.startsWith('L:')) {
      const tipoDelFormulario = String(survey.LocationTypeID ?? '');
      if (tipoDelFormulario && tipoDelFormulario !== '0') {
        const sede = await this.locations.findByLocationId(
          resolveCatalogOwnerId(user),
          punto.substring(2),
        );
        // En `LocationsForms`, `LocationTypeGUID` guarda el número del tipo
        // (el nombre engaña) y `LocationTypeGD` su GUID.
        if (sede && String(sede.LocationTypeGUID ?? '') === tipoDelFormulario) {
          await this.answers.attachLocation(nueva.ID, sede);
        }
      }
    }

    this.activities.notifyChanged();

    this.toasts.show({
      title: `Nueva actividad: ${survey.Title ?? ''}`,
      detail: d.geocercaNombre
        ? `La creó la geocerca «${d.geocercaNombre}».`
        : 'La creó una geocerca.',
      tone: 'info',
      icon: 'map-pin',
      action: {
        label: 'Abrir',
        run: () =>
          void this.router.navigate(['/formularios', survey.SurveyID, 'actividad', nueva.GUID]),
      },
    });
  }

  // ─── La subida ─────────────────────────────────────────────────────────────

  /**
   * Cuenta a cloud-gold lo que no ha contado, con el token de la sesión.
   *
   * Solo marca como enviados los que el servidor dice que recibió: lo que
   * falló por algo pasajero se vuelve a intentar en la próxima vuelta. Es
   * `EventosDeGeocerca.subir` del teléfono.
   */
  async subirEventos(): Promise<void> {
    const user = this.auth.currentUser();
    if (!user?.Token || this.subiendo) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    this.subiendo = true;
    try {
      const pendientes = (await this.leerCola(user.UserID)).filter((e) => e.Enviado === 0).slice(0, 50);
      if (!pendientes.length) return;

      // `fetch` directo y no `HttpClient`: el interceptor cerraría la sesión
      // con un 401 de Module, y un evento que no se pudo contar no es motivo.
      const respuesta = await fetch(`${environment.moduleUrl}/geofence-flows/eventos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.Token}`,
        },
        body: JSON.stringify({
          deviceId: user.DeviceID ?? '',
          eventos: pendientes.map((e) => e.Payload),
        }),
      });
      if (!respuesta.ok) return;

      const cuerpo = await respuesta.json().catch(() => null);
      const recibidos = new Set<string>(
        Array.isArray(cuerpo?.recibidos) ? cuerpo.recibidos.map(String) : [],
      );
      const enviados = pendientes.filter((e) => recibidos.has(e.Clave));

      await this.db.transaction('EventosGeocerca', 'readwrite', async (tx) => {
        const store = tx.objectStore('EventosGeocerca');
        for (const e of enviados) store.put({ ...e, Enviado: 1 });
      });
    } catch {
      // Sin red o el servidor caído: se reintenta en la próxima vuelta.
    } finally {
      this.subiendo = false;
      await this.limpiar();
    }
  }

  private async leerCola(userId: string): Promise<EventoEnCola[]> {
    return this.db.transaction<EventoEnCola[]>('EventosGeocerca', 'readonly', (tx) =>
      this.db.request<EventoEnCola[]>(tx.objectStore('EventosGeocerca').index('byUserID').getAll(userId)),
    );
  }

  /**
   * Lo de más de una semana sobra.
   *
   * Lo ya contado **no** se borra en el acto: es el respaldo de la pantalla del
   * evento cuando se toca su alerta sin red. La cola sigue mirando solo
   * `Enviado = 0`, así que guardarlo no reenvía nada.
   */
  private async limpiar(): Promise<void> {
    try {
      const limite = Date.now() - SEMANA_MS;
      await this.db.transaction('EventosGeocerca', 'readwrite', async (tx) => {
        const store = tx.objectStore('EventosGeocerca');
        const todos = await this.db.request<EventoEnCola[]>(store.getAll());
        for (const e of todos) {
          if (e.Creado < limite && e.ID !== undefined) store.delete(e.ID);
        }
      });
    } catch {
      // Limpiar es higiene: si falla, se limpia la próxima vez.
    }
  }

  // ─── El estado de la vigía, para no redisparar al recargar ────────────────

  private claveDeEstado(userId: string, que: 'vigia' | 'momentos'): string {
    return `visitrack.geocercas.${que}::${userId}`;
  }

  private leerEstado(userId: string, que: 'vigia' | 'momentos' = 'vigia'): EstadoDeVigia {
    try {
      const crudo = localStorage.getItem(this.claveDeEstado(userId, que));
      const leido = crudo ? JSON.parse(crudo) : {};
      return leido && typeof leido === 'object' ? leido : {};
    } catch {
      return {};
    }
  }

  private guardarEstado(
    userId: string,
    estado: EstadoDeVigia,
    que: 'vigia' | 'momentos' = 'vigia',
  ): void {
    try {
      localStorage.setItem(this.claveDeEstado(userId, que), JSON.stringify(estado));
    } catch {
      // Sin almacenamiento: la próxima recarga aprenderá de nuevo, sin disparar.
    }
  }
}
