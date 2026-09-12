import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { apiBaseUrl } from '../config/api-base';
import { resolveCatalogOwnerId } from '../config/company-rules';
import { guardarCompaniaDelEnlace } from '../config/modo-publico';
import { ThemeService } from './theme.service';
import { DatabaseService } from '../database/database.service';
import { Asset, LocationForm } from '../models/entities.model';
import { User } from '../models/user.model';
import { UserRepository } from '../repositories/user.repository';
import { ENTITY_MAPPERS, ENTITY_TO_STORE } from '../sync/entity-mappers';
import { AuthService } from './auth.service';

/** Lo que el enlace dejó decidido de antemano. */
export interface ConfiguracionDelEnlace {
  nombre: string;
  surveyId: number;
  companyId: number;
  userId: number;

  /** El enlace trae la ubicación fijada: no se pregunta. */
  conUbicacion: boolean;
  conActivo: boolean;

  /**
   * Color de fondo de la página, `#rrggbb`. Vacío = el gris de la aplicación.
   *
   * Es del enlace, no de quien lo abre: quien reparte un enlace decide cómo se
   * ve, igual que decide qué formulario abre.
   */
  fondo: string;

  /** Nombre de la compañia dueña del enlace. Rotula el banner si no hay logo. */
  compania: string;
}

/** Filas crudas del servidor, agrupadas por código de entidad. */
type Semilla = Record<string, Record<string, unknown>[]>;

interface RespuestaAbrir {
  enlace: ConfiguracionDelEnlace;
  usuario: Record<string, unknown>;
  entidades: Semilla;
}

/** Una página de entidades para elegir. */
export interface PaginaDeEntidades<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** Por qué no se pudo abrir un enlace. */
export type MotivoDeCierre = 'caducado' | 'agotado' | 'sin-formulario' | 'sin-usuario' | 'otro';

export class EnlaceCerrado extends Error {
  constructor(
    readonly motivo: MotivoDeCierre,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'EnlaceCerrado';
  }
}

/**
 * Resolver un enlace público y dejar el navegador listo para diligenciar.
 *
 * ## Lo que hace, en una frase
 *
 * Pedirle al servidor lo que la sincronización habría bajado —el usuario, el
 * formulario, su flujo, sus listas y las entidades que el enlace fijó— y
 * escribirlo en la base pública **con los mismos mapeadores que usa la
 * sincronización**.
 *
 * Eso último es lo que hace que el resto de la aplicación no se entere de nada.
 * Una traducción propia habría sido más corta de escribir y habría empezado a
 * diferir de la original en cuanto alguien agregara un campo a un formulario:
 * dos traducciones acaban siendo dos formatos, y el segundo solo se descubre
 * cuando algo no se pinta.
 *
 * ## Siempre en línea
 *
 * Aquí no hay sincronización previa ni sesión, así que todo esto se consulta al
 * abrir. Es la diferencia de fondo con la aplicación normal, y por eso un
 * enlace público no funciona sin conexión — cosa que la pantalla dice, en vez
 * de quedarse cargando.
 */
@Injectable({ providedIn: 'root' })
export class EnlacePublicoService {
  private readonly http = inject(HttpClient);
  private readonly db = inject(DatabaseService);
  private readonly users = inject(UserRepository);
  private readonly auth = inject(AuthService);
  private readonly tema = inject(ThemeService);

  /**
   * Resuelve el enlace, siembra la base y abre la sesión del usuario quemado.
   *
   * @returns la configuración del enlace, que es lo que la pantalla necesita
   *   para saber si tiene que pedir ubicación y activo.
   */
  async abrir(): Promise<ConfiguracionDelEnlace> {
    const datos = await this.pedirLaSemilla();

    await this.sembrar(datos);

    /*
     * La sesión se abre **después** de sembrar.
     *
     * `restoreSession` lee la fila de `Users` con `Session = '1'`, así que si se
     * llamara antes no encontraría nada y todo lo que depende de que haya
     * usuario —crear la actividad, guardar una foto, leer el flujo— fallaría
     * con «No hay una sesión activa» en una pantalla donde eso no significa
     * nada para quien la está mirando.
     */
    await this.auth.restoreSession();

    /*
     * El fondo que eligió quien armó el enlace.
     *
     * Se aplica **sin guardarlo**: `localStorage` se comparte entre todas las
     * pestañas del mismo origen, así que persistirlo le cambiaría el fondo a la
     * sesión que esa persona pueda tener abierta al lado. La base pública sí
     * está aislada; `localStorage` no. Ver `aplicarFondoDeEnlace`.
     */
    guardarCompaniaDelEnlace(datos.enlace.compania ?? '');

    if (datos.enlace.fondo) {
      this.tema.aplicarFondoDeEnlace(datos.enlace.fondo);
    } else {
      /*
       * Sin color no se hace nada —queda el gris—, pero se deja dicho por que.
       *
       * «No me coge el color de fondo» tiene dos causas que desde la pantalla
       * se ven idénticas: que el enlace no tenga color guardado, o que el
       * servidor sea una version anterior a la que devuelve el campo. La
       * primera se arregla en Module y la segunda subiendo `EnlacesPublicos.js`,
       * y sin este aviso no hay forma de saber cual de las dos es.
       */
      console.info(
        '[Enlace] este enlace no trae color de fondo. Si le pusiste uno en Module, ' +
          'el servidor todavía no devuelve el campo «fondo»: falta subir ' +
          'src/controllers/Public/EnlacesPublicos.js a cloud-server.',
        datos.enlace,
      );
    }

    return datos.enlace;
  }

  private async pedirLaSemilla(): Promise<RespuestaAbrir> {
    try {
      const respuesta = await firstValueFrom(
        this.http
          .get<{ status?: boolean; response?: RespuestaAbrir; error?: string; motivo?: string }>(
            apiBaseUrl(),
          )
          .pipe(timeout(30_000)),
      );

      if (!respuesta?.status || !respuesta.response) {
        throw new EnlaceCerrado(
          (respuesta?.motivo as MotivoDeCierre) ?? 'otro',
          respuesta?.error ?? 'Este enlace no está disponible.',
        );
      }

      return respuesta.response;
    } catch (error) {
      if (error instanceof EnlaceCerrado) throw error;

      // El cuerpo del error trae el motivo cuando el servidor cerró la puerta a
      // propósito (410). Distinguirlo importa: «venció» se resuelve pidiendo un
      // enlace nuevo, y «no hay conexión» esperando.
      const cuerpo = (error as { error?: { error?: string; motivo?: string } })?.error;

      if (cuerpo?.motivo) {
        throw new EnlaceCerrado(cuerpo.motivo as MotivoDeCierre, cuerpo.error ?? '');
      }

      throw new Error(
        'No se pudo abrir el formulario. Comprueba tu conexión e inténtalo de nuevo.',
      );
    }
  }

  /**
   * Escribe la semilla en la base pública.
   *
   * Se agrupa por store y se escribe con `putMany` de una vez por store: una
   * transacción por registro sobre veinte listas sería lenta sin ninguna razón,
   * y aquí hay alguien esperando delante de una pantalla en blanco.
   */
  private async sembrar(datos: RespuestaAbrir): Promise<void> {
    const ownerId = this.duenoDelCatalogo(datos.enlace.companyId, datos.enlace.userId);

    await this.guardarUsuario(datos.usuario, datos.enlace);

    for (const [codigo, filas] of Object.entries(datos.entidades ?? {})) {
      if (!Array.isArray(filas) || filas.length === 0) continue;

      const store = ENTITY_TO_STORE[Number(codigo)];
      const mapper = ENTITY_MAPPERS[Number(codigo)];

      if (!store || !mapper) continue;

      const registros = filas.map((fila) => mapper(fila, ownerId));

      await this.db.transaction(store, 'readwrite', (tx) => {
        const objectStore = tx.objectStore(store);
        for (const registro of registros) objectStore.put(registro);
      });
    }
  }

  /**
   * Bajo qué `UserID` se guardan los catálogos.
   *
   * Casi siempre es el del propio usuario, pero hay una compañía cuyos
   * catálogos cuelgan de una cuenta compartida (ver `company-rules.ts`). Todo
   * lo que consulta un formulario —ubicaciones, activos, listas, el propio
   * formulario— pasa por `resolveCatalogOwnerId`, así que sembrarlos bajo otro
   * identificador los dejaría guardados donde nadie los busca: el enlace
   * abriría un formulario en blanco sin ningún error a la vista.
   */
  private duenoDelCatalogo(companyId: number, userId: number): number {
    return resolveCatalogOwnerId({ UserID: String(userId), CompanyID: Number(companyId) });
  }

  /**
   * Deja al usuario del enlace como la sesión de esta base.
   *
   * No es un inicio de sesión: no hay contraseña, no hay token y esta fila no
   * sale de la base pública. Es lo que permite que el resto de la aplicación
   * —que en todas partes pregunta «¿de quién es esto?»— funcione sin cambios.
   *
   * `Token` va vacío a propósito. El interceptor solo pone la cabecera cuando
   * hay token, así que las peticiones salen limpias — que es justo lo que
   * espera la parte pública del servidor, donde lo que autoriza es el GUID del
   * enlace que ya viaja en la dirección.
   */
  private async guardarUsuario(
    fila: Record<string, unknown>,
    enlace: ConfiguracionDelEnlace,
  ): Promise<void> {
    const texto = (valor: unknown, porDefecto = '') =>
      valor === null || valor === undefined ? porDefecto : String(valor);

    const usuario: User = {
      UserID: texto(fila['ID'], String(enlace.userId)),
      GUID: texto(fila['GUID']),
      CompanyID: Number(fila['CompanyID']) || enlace.companyId,
      FirstName: texto(fila['FirstName']),
      LastName: texto(fila['LastName']),
      Email: texto(fila['Email']),

      /*
       * El login identifica la fila en la base (`byLogin` es único). Se le pone
       * el del usuario real porque es lo que se ve en pantalla, y esta base solo
       * tiene una cuenta: no hay con quién chocar.
       */
      Login: texto(fila['Login']).trim().toLowerCase(),

      // Ni contraseña ni token: aquí no hubo inicio de sesión que los produjera.
      Password: '',
      Token: '',

      UTCCode: texto(fila['UTCCode']),

      // El enlace público también pinta fechas, así que también necesita zona.
      // Ver `ZonaHorariaService`.
      UTCMinutes: typeof fila['UTCMinutes'] === 'number' && Number.isFinite(fila['UTCMinutes'] as number)
        ? (fila['UTCMinutes'] as number)
        : null,
      UTCName: texto(fila['UTCName']),

      DefaultLanguage: texto(fila['DefaultLanguage'], 'es'),
      GroupID: Number(fila['GroupID']) || 0,
      DivisionID: Number(fila['DivisionID']) || 0,
      Active: '1',
      WorkZoneID: fila['WorkZoneID'] == null ? null : Number(fila['WorkZoneID']),
      apiref1: '',
      Session: '1',
      StatusID: texto(fila['StatusID']),
      Phone: texto(fila['Phone']),

      /*
       * Un identificador de equipo estable para esta pestaña.
       *
       * No se usa para autenticar nada —la parte pública no mira dispositivos—
       * pero varias piezas lo leen y dejarlo vacío haría que alguna guardara
       * una cadena en blanco donde espera un identificador.
       */
      DeviceID: `enlace-publico`,
    };

    await this.users.upsertAndActivate(usuario);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Elegir entidades en línea
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Una página de ubicaciones entre las que elegir.
   *
   * Paginadas y con buscador porque el catálogo de una compañía son miles de
   * sedes: traerlas todas para pintar una lista deja el navegador colgado
   * justo en la primera pantalla que ve alguien que no conoce la aplicación.
   */
  async ubicaciones(busqueda: string, pagina: number): Promise<PaginaDeEntidades<LocationForm>> {
    return this.pagina<LocationForm>('ubicaciones', { q: busqueda, page: pagina });
  }

  /**
   * Ubicaciones de **un tipo concreto**, para un desplegable del formulario.
   *
   * Distinto de [ubicaciones]: aquel ofrece las del tipo que pide el formulario
   * para abrir la actividad; este, las del tipo que pide un campo. Un acta
   * puede preguntar la sede en la cabecera y, dentro, tener un desplegable con
   * los equipos — y son dos catálogos distintos.
   *
   * El servidor solo admite tipos que ese formulario menciona: ver
   * `tipoQuePideElCampo` en el controlador.
   */
  async ubicacionesDeTipo(tipo: string, busqueda: string): Promise<LocationForm[]> {
    const pagina = await this.pagina<LocationForm>('ubicaciones', {
      tipo,
      q: busqueda,
      page: 1,
    });

    return pagina.items;
  }

  /** Activos de un tipo, sin acotar por sede. Igual que [ubicacionesDeTipo]. */
  async activosDeTipo(tipo: string, busqueda: string): Promise<Asset[]> {
    const pagina = await this.pagina<Asset>('activos', { tipo, q: busqueda, page: 1 });

    return pagina.items;
  }

  /** Los activos de la ubicación elegida, igual. */
  async activos(
    locationId: string | number,
    busqueda: string,
    pagina: number,
  ): Promise<PaginaDeEntidades<Asset>> {
    return this.pagina<Asset>('activos', { loc: String(locationId), q: busqueda, page: pagina });
  }

  private async pagina<T>(
    ruta: string,
    params: Record<string, string | number>,
  ): Promise<PaginaDeEntidades<T>> {
    const consulta = Object.entries(params)
      .map(([clave, valor]) => `${clave}=${encodeURIComponent(String(valor))}`)
      .join('&');

    const respuesta = await firstValueFrom(
      this.http
        .get<{ status?: boolean; response?: PaginaDeEntidades<Record<string, unknown>> }>(
          `${apiBaseUrl()}/${ruta}?${consulta}`,
        )
        .pipe(timeout(30_000)),
    );

    if (!respuesta?.status || !respuesta.response) {
      throw new Error('No se pudieron traer los datos. Comprueba tu conexión.');
    }

    return respuesta.response as unknown as PaginaDeEntidades<T>;
  }

  /**
   * Guarda en la base pública la entidad elegida.
   *
   * Es lo que hace que después funcione todo lo demás sin excepciones:
   * `attachLocation`, `attachAsset` y la comprobación de coherencia entre las
   * dos leen de la base, no de lo que traiga la pantalla. Si la entidad elegida
   * no estuviera guardada, la actividad quedaría apuntando a algo que en este
   * navegador no existe — y eso es exactamente lo que esa comprobación bloquea.
   */
  async guardarEntidad(
    entidad: 1 | 12,
    fila: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const store = ENTITY_TO_STORE[entidad];
    const mapper = ENTITY_MAPPERS[entidad];

    if (!store || !mapper) return null;

    // Bajo el mismo `UserID` con el que se sembró todo lo demás: es el que
    // usan las consultas de los selectores y el de la comprobación de
    // coherencia entre ubicación y activo.
    const usuario = this.auth.currentUser();
    if (!usuario) return null;

    const registro = mapper(fila, resolveCatalogOwnerId(usuario));

    await this.db.transaction(store, 'readwrite', (tx) => {
      tx.objectStore(store).put(registro);
    });

    /*
     * Se devuelve el registro **ya mapeado**.
     *
     * Quien lo pidió tiene que asociarlo a la actividad, y lo que hay que
     * asociar es esta forma —la local— y no la que trajo el servidor. Buscarlo
     * de nuevo en la base sería un viaje más para llegar a lo mismo, y hacerlo
     * «por el primero del store» se rompería en cuanto alguien eligiera dos
     * veces.
     */
    return registro;
  }
}
