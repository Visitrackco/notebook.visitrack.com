import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { environment } from '../../../environments/environment';
import { resolveCatalogOwnerId } from '../config/company-rules';
import { traducir } from '../i18n/idioma.service';
import { ANSWER_STATE } from '../models/activity.model';
import { SurveyAnswer } from '../models/entities.model';
import { DispatchStatusRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { CompanyLogicService } from '../rules/company-logic.service';
import { AuthService } from '../services/auth.service';
import { SyncService } from '../sync/sync.service';
import { PerfilInventario, calcularLineas, efecto, leerPerfil, numero, tocaMover } from './perfil-inventario';

/**
 * Una actividad de este usuario que el servidor no pudo mover por falta de
 * stock (perfil en «Bloquear»): otra salida llegó antes, o se procesó horas
 * después. Hay que corregirla y volver a guardarla.
 */
export interface ActividadSinStock {
  guid: string;
  answerId: number;
  /** Lo que falta, como lo dice el servidor: «Tornillo: pide 20 y hay 10 und». */
  mensaje: string;
  al: Date | null;
}

/**
 * Cómo va el descuento de inventario de una actividad, para decírselo a quien
 * la diligencia. `hecho`: el servidor ya la descontó. `listo`: ya cumple y se
 * descuenta al llegar. `falta`: aún no; `texto` dice qué le falta.
 */
export interface DescuentoDeInventario {
  estado: 'hecho' | 'listo' | 'falta';
  texto: string;
}

/** El stock de un item de una lista de productos, como lo supo la web. */
export interface StockDeItem {
  guid: string;
  listId: number;
  nombre: string;
  disponible: number;
  unidad: string;
}

/** Un producto al que no le alcanza el stock para esta actividad. */
export interface FaltanteDeStock {
  nombre: string;
  pide: number;
  hay: number;
  unidad: string;
}

/** Lo que se decidió al revisar una actividad. `accion` vacía: nada que decir. */
export interface RevisionDeStock {
  accion: '' | 'bloquear' | 'avisar';
  faltantes: FaltanteDeStock[];
}

const NADA: RevisionDeStock = { accion: '', faltantes: [] };

/** Lo que contesta `GET /inventory/de-campo` de Module. */
interface Respuesta {
  status?: boolean;
  instalado?: boolean;
  sinCambios?: boolean;
  firma?: string;
  al?: string;
  perfiles?: { SurveyID?: unknown; perfil?: unknown }[];
  stock?: { g?: unknown; l?: unknown; n?: unknown; d?: unknown; u?: unknown }[];
  bloqueadas?: unknown[];
  movidas?: unknown[];
}

/** Lo que se guarda por usuario en `localStorage`. */
interface Guardado {
  firma: string;
  al: string;
  perfiles: unknown[];
  stock: unknown[];
  bloqueadas?: unknown[];
  movidas?: unknown[];
}

/** Cada cuánto se vuelve a preguntar, además de al sincronizar. */
const REFRESCAR_CADA_MS = 5 * 60_000;

/**
 * El inventario en la web (fase 2 del inventario con listas): gemelo de
 * `InventarioCampo.dart` del móvil.
 *
 * - **De dónde sale.** De Module (`GET /inventory/de-campo`), con el token de
 *   la sesión de campo: al iniciar sesión, al terminar cada sincronización,
 *   cada cinco minutos y al abrir un formulario con perfil. Se guarda por
 *   usuario en `localStorage` para que valga sin red.
 * - **Qué da.** El disponible de cada item de las listas de productos
 *   ([disponible], para enseñarlo en el formulario) y la revisión de una
 *   actividad antes de guardarla ([revisar]), según el `negativo` del perfil
 *   de su formulario: bloquear, avisar o permitir.
 * - **Qué no hace.** Mover stock: eso solo lo hace el servidor al recibir la
 *   actividad. Sin datos (sin sincronizar, Module viejo, compañía sin
 *   inventario) no avisa ni bloquea nada.
 */
@Injectable({ providedIn: 'root' })
export class InventarioDeCampoService {
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly estadosRepo = inject(DispatchStatusRepository);
  private readonly companyLogic = inject(CompanyLogicService);

  private readonly stock = signal<ReadonlyMap<string, StockDeItem>>(new Map());
  private readonly perfiles = signal<ReadonlyMap<string, PerfilInventario>>(new Map());
  private readonly frenadas = signal<ReadonlyMap<string, ActividadSinStock>>(new Map());
  /** GUID → ID de las actividades de este usuario que ya movieron inventario. */
  private readonly movidas = signal<ReadonlyMap<string, number>>(new Map());

  /** Las actividades de este usuario que el servidor frenó por falta de stock. */
  readonly bloqueadas = computed(() => [...this.frenadas().values()]);

  /** Cuándo se supo el stock (hora del servidor), o `null` si nunca. */
  readonly al = signal<Date | null>(null);

  readonly hayDatos = computed(() => this.stock().size > 0 || this.perfiles().size > 0);

  private firma = '';
  private usuario = '';
  private generacion = 0;
  private enCurso: Promise<void> | null = null;
  private ultimoIntento = 0;

  constructor() {
    // Con cada sesión, lo suyo: iniciar, cambiar de cuenta, «entrar como», cerrar.
    effect(() => {
      const id = String(this.auth.currentUser()?.UserID ?? '');
      untracked(() => this.cambiarDeUsuario(id));
    });

    // Al terminar cada sincronización, como los permisos de Module.
    const fase = computed(() => this.sync.state().phase);
    effect(() => {
      if (fase() !== 'done') return;
      untracked(() => void this.sincronizar());
    });

    const reloj = setInterval(() => void this.sincronizar(), REFRESCAR_CADA_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(reloj));
  }

  /** El disponible del item [guid], o `null` si no es un producto enlazado (o no se sabe). */
  disponible(guid: unknown): StockDeItem | null {
    const g = String(guid ?? '').trim().toLowerCase();
    return g ? (this.stock().get(g) ?? null) : null;
  }

  /** Si la actividad [guid] está frenada en el servidor por falta de stock. */
  bloqueadaDe(guid: unknown): ActividadSinStock | null {
    const g = String(guid ?? '').trim().toLowerCase();
    return g ? (this.frenadas().get(g) ?? null) : null;
  }

  /** El ID de la actividad [guid] si el servidor ya movió su inventario, o `null`. */
  movidaDe(guid: unknown): number | null {
    const g = String(guid ?? '').trim().toLowerCase();
    return g ? (this.movidas().get(g) ?? null) : null;
  }

  perfilDe(surveyId: unknown): PerfilInventario | null {
    const id = String(surveyId ?? '').trim();
    return id ? (this.perfiles().get(id) ?? null) : null;
  }

  /** Le pregunta a Module. No falla nunca: sin red, se queda con lo que tenía. */
  sincronizar(): Promise<void> {
    return (this.enCurso ??= this.preguntar().finally(() => (this.enCurso = null)));
  }

  /**
   * Como [sincronizar], pero solo si lo último tiene más de [edadMs] (y no se
   * intentó hace menos de un minuto): para abrir un formulario sin ir a la red
   * cada vez.
   */
  async sincronizarSiViejo(edadMs = 2 * 60_000): Promise<void> {
    const ahora = Date.now();
    if (ahora - this.ultimoIntento < 60_000) return;
    const al = this.al();
    if (al && ahora - al.getTime() < edadMs) return;
    await this.sincronizar();
  }

  /**
   * ¿Alcanza el stock para la actividad tal como se va a guardar?
   *
   * - Solo si su formulario tiene perfil con `negativo` = bloquear o avisar, y
   *   la actividad está en el momento de mover ([completada], su estado).
   * - Disponible = lo que dijo Module − lo que piden **otras** actividades de
   *   este navegador que todavía no han subido (el servidor aún no las
   *   descontó).
   * - Si esta actividad ya había subido, el servidor ya le descontó algo que
   *   la web no sabe: no se bloquea, solo se avisa.
   */
  async revisar(answer: SurveyAnswer, campos: unknown, completada: boolean): Promise<RevisionDeStock> {
    try {
      const stock = this.stock();
      if (stock.size === 0 || this.perfiles().size === 0) return NADA;

      const perfil = this.perfilDe(answer.SurveyID);
      if (!perfil || perfil.negativo === 'permitir') return NADA;
      const frenada = this.bloqueadaDe(answer.GUID) !== null;
      // Ya movió y el formulario mueve una sola vez: guardarla otra vez no saca nada.
      if (perfil.repetir === 'una_vez' && this.movidaDe(answer.GUID) !== null && !frenada) return NADA;

      // Como la verá el servidor (ver [comoQueda]): sin pendientes no basta.
      const como = await this.comoQueda(answer, completada);
      const estado = como.estado;
      if (!tocaMover(perfil, como.completada, estado)) return NADA;

      const pide = efectoPorItem(perfil, campos, estado);
      const salen = [...pide.entries()].filter(([g, v]) => v < 0 && stock.has(g));
      if (salen.length === 0) return NADA;

      // Lo que ya están pidiendo las otras actividades sin subir.
      const reservado = new Map<string, number>();
      for (const otra of await this.answers.findByUser(answer.UserID)) {
        if (otra.GUID === answer.GUID || yaSubio(otra) || Number(otra.IsMovilDeleted ?? 0) === 1) continue;
        const p = this.perfilDe(otra.SurveyID);
        if (!p) continue;
        const e = estadoDe(otra);
        if (!tocaMover(p, String(otra.CompletedOn ?? '').trim() !== '', e)) continue;
        for (const [g, v] of efectoPorItem(p, otra.Fields, e)) reservado.set(g, (reservado.get(g) ?? 0) + v);
      }

      const faltantes: FaltanteDeStock[] = [];
      for (const [g, v] of salen) {
        const s = stock.get(g)!;
        const hay = s.disponible + (reservado.get(g) ?? 0);
        if (hay + v < -0.00005) faltantes.push({ nombre: s.nombre, pide: -v, hay: Math.max(0, hay), unidad: s.unidad });
      }
      if (faltantes.length === 0) return NADA;

      // Ya subió, pero el servidor la frenó por falta de stock: no le descontó
      // nada de esta versión, así que «bloquear» sigue valiendo.
      const subio = yaSubio(answer) && !frenada;
      return { accion: perfil.negativo === 'bloquear' && !subio ? 'bloquear' : 'avisar', faltantes };
    } catch (error) {
      // Revisar no puede impedir guardar por un error propio.
      console.warn('[inventario] no se pudo revisar el stock', error);
      return NADA;
    }
  }

  /**
   * Cómo queda la actividad al guardarla, **como la verá el servidor**:
   * completada si tiene fecha de completada o su estado cuenta como
   * completado. Guardarla sin obligatorios pendientes ([sinPendientes]) solo
   * la completa si le toca un estado de completada (`estadoAlCompletar`); si
   * no, queda con el estado que traía y el servidor no la da por completada.
   * Gemelo de `comoQueda` del móvil.
   */
  async comoQueda(answer: SurveyAnswer, sinPendientes: boolean): Promise<{ completada: boolean; estado: number | null }> {
    let estado = estadoDe(answer);
    let completada = String(answer.CompletedOn ?? '').trim() !== '';

    if (sinPendientes) {
      const decision = await this.companyLogic.estadoAlCompletar(answer);
      if (decision?.nuevo) {
        completada = true;
        const n = Number(decision.nuevo);
        if (Number.isFinite(n)) estado = n;
      }
    }
    if (!completada && estado !== null) {
      const catalogo = await this.catalogoDeEstados();
      completada = catalogo.some((s) => Number(s.DispatchID) === estado && Number(s.IsCompleted) === 1);
    }
    return { completada, estado };
  }

  /**
   * Cómo va el descuento de la actividad, en palabras: ya se descontó, ya
   * cumple, o qué le falta. `null`: su formulario no mueve inventario.
   * [completa]: si se está guardando sin obligatorios pendientes. Gemelo de
   * `comoVaElDescuento` del móvil.
   */
  async comoVaElDescuento(answer: SurveyAnswer, completa = false): Promise<DescuentoDeInventario | null> {
    try {
      const perfil = this.perfilDe(answer.SurveyID);
      if (!perfil) return null;

      const id = this.movidaDe(answer.GUID);
      if (id !== null && !this.bloqueadaDe(answer.GUID)) {
        const numero = id > 0 ? ` (#${id})` : '';
        return {
          estado: 'hecho',
          texto: traducir(perfil.repetir === 'ajustar' ? 'inv.yaDescontadoAjusta' : 'inv.yaDescontado', { numero }),
        };
      }

      const como = await this.comoQueda(answer, completa);
      if (tocaMover(perfil, como.completada, como.estado)) return { estado: 'listo', texto: traducir('inv.descuentoListo') };

      const catalogo = await this.catalogoDeEstados();
      if (perfil.cuando.modo === 'estados') {
        const nombres = perfil.cuando.estados
          .map((id) => catalogo.find((s) => Number(s.DispatchID) === id)?.Name ?? `#${id}`)
          .join(', ');
        return { estado: 'falta', texto: traducir('inv.faltaEstado', { estados: nombres }) };
      }
      const completados = [
        ...new Set(
          catalogo
            .filter((s) => Number(s.IsCompleted) === 1 && !['Deleted', 'Deleted by Policy'].includes(String(s.Name)))
            .map((s) => String(s.Name ?? '').trim())
            .filter(Boolean),
        ),
      ].sort();
      return {
        estado: 'falta',
        texto: completados.length
          ? traducir('inv.faltaCompletar', { estados: completados.join(', ') })
          : traducir('inv.faltaCompletarSinEstados'),
      };
    } catch (error) {
      console.warn('[inventario] no se pudo decir cómo va el descuento', error);
      return null;
    }
  }

  private async catalogoDeEstados() {
    const user = this.auth.currentUser();
    if (!user) return [];
    return (await this.estadosRepo.findByUser(resolveCatalogOwnerId(user))).filter((s) => Number(s.IsDeleted ?? 0) !== 1);
  }

  private cambiarDeUsuario(id: string): void {
    if (id === this.usuario) return;

    this.generacion++;
    this.usuario = id;
    this.enCurso = null;
    this.firma = '';

    // Lo de la cuenta anterior no vale para la siguiente.
    this.aplicar(id ? this.leer(id) : null);
    if (id) void this.sincronizar();
  }

  /**
   * `fetch` directo y no `HttpClient`, como los permisos de Module: el
   * interceptor cerraría la sesión con un 401 de Module, y no poder ver el
   * stock no es motivo.
   */
  private async preguntar(): Promise<void> {
    const user = this.auth.currentUser();
    const id = String(user?.UserID ?? '');
    const token = user?.Token ?? '';
    if (!id || !token) return;

    const generacion = this.generacion;
    this.ultimoIntento = Date.now();

    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), 30_000);
    try {
      const url = new URL(`${environment.moduleUrl}/inventory/de-campo`);
      if (this.firma) url.searchParams.set('firma', this.firma);

      const respuesta = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: corte.signal,
      });
      if (!respuesta.ok) return;

      const cuerpo = (await respuesta.json().catch(() => null)) as Respuesta | null;
      // Mientras viajaba cambió la sesión: esto ya no es de nadie.
      if (!cuerpo || cuerpo.status !== true || generacion !== this.generacion || id !== this.usuario) return;

      if (cuerpo.sinCambios) {
        this.al.set(new Date());
        return;
      }

      const guardado: Guardado =
        cuerpo.instalado === false
          ? { firma: '', al: '', perfiles: [], stock: [], bloqueadas: [], movidas: [] }
          : {
              firma: String(cuerpo.firma ?? ''),
              al: String(cuerpo.al ?? ''),
              perfiles: Array.isArray(cuerpo.perfiles) ? cuerpo.perfiles : [],
              stock: Array.isArray(cuerpo.stock) ? cuerpo.stock : [],
              bloqueadas: Array.isArray(cuerpo.bloqueadas) ? cuerpo.bloqueadas : [],
              movidas: Array.isArray(cuerpo.movidas) ? cuerpo.movidas : [],
            };
      this.aplicar(guardado);
      this.guardar(id, guardado);
    } catch {
      // Sin red o Module caído: se queda lo que se sabía.
    } finally {
      clearTimeout(reloj);
    }
  }

  private aplicar(g: Guardado | null): void {
    const stock = new Map<string, StockDeItem>();
    for (const s of g?.stock ?? []) {
      if (!s || typeof s !== 'object') continue;
      const o = s as Record<string, unknown>;
      const guid = String(o['g'] ?? '').trim().toLowerCase();
      if (!guid) continue;
      stock.set(guid, {
        guid,
        listId: Number(o['l']) || 0,
        nombre: String(o['n'] ?? ''),
        disponible: numero(o['d']) ?? 0,
        unidad: String(o['u'] ?? ''),
      });
    }
    const perfiles = new Map<string, PerfilInventario>();
    for (const p of g?.perfiles ?? []) {
      if (!p || typeof p !== 'object') continue;
      const o = p as Record<string, unknown>;
      const surveyId = String(o['SurveyID'] ?? '').trim();
      if (surveyId) perfiles.set(surveyId, leerPerfil(o['perfil']));
    }
    const frenadas = new Map<string, ActividadSinStock>();
    for (const b of g?.bloqueadas ?? []) {
      if (!b || typeof b !== 'object') continue;
      const o = b as Record<string, unknown>;
      const guid = String(o['g'] ?? '').trim().toLowerCase();
      if (!guid) continue;
      const al = o['al'] ? new Date(String(o['al'])) : null;
      frenadas.set(guid, {
        guid,
        answerId: Number(o['id']) || 0,
        mensaje: String(o['m'] ?? ''),
        al: al && !Number.isNaN(al.getTime()) ? al : null,
      });
    }
    const movidas = new Map<string, number>();
    for (const m of g?.movidas ?? []) {
      if (!m || typeof m !== 'object') continue;
      const o = m as Record<string, unknown>;
      const guid = String(o['g'] ?? '').trim().toLowerCase();
      if (guid) movidas.set(guid, Number(o['id']) || 0);
    }
    this.stock.set(stock);
    this.perfiles.set(perfiles);
    this.frenadas.set(frenadas);
    this.movidas.set(movidas);
    this.firma = g?.firma ?? '';
    const al = g?.al ? new Date(g.al) : null;
    this.al.set(al && !Number.isNaN(al.getTime()) ? al : null);
  }

  private claveDeCache(userId: string): string {
    return `visitrack.inventarioDeCampo::${userId}`;
  }

  private leer(userId: string): Guardado | null {
    try {
      const crudo = localStorage.getItem(this.claveDeCache(userId));
      return crudo ? (JSON.parse(crudo) as Guardado) : null;
    } catch {
      return null;
    }
  }

  private guardar(userId: string, g: Guardado): void {
    try {
      localStorage.setItem(this.claveDeCache(userId), JSON.stringify(g));
    } catch {
      // Sin almacenamiento: vale para esta pestaña y se vuelve a pedir al recargar.
    }
  }
}

function estadoDe(a: SurveyAnswer): number | null {
  const n = Number(String(a.Status ?? '').trim());
  return String(a.Status ?? '').trim() && Number.isFinite(n) ? n : null;
}

/** ¿La actividad ya llegó a Visitrack alguna vez? Entonces el servidor ya le descontó. */
function yaSubio(a: SurveyAnswer): boolean {
  const answerId = String(a.AnswerID ?? '').trim();
  return (
    String(a.IsUpload ?? '') === '1' ||
    Number(a.isSaved) === ANSWER_STATE.SYNCED ||
    (answerId !== '' && answerId !== '0' && answerId !== 'null')
  );
}

/** Efecto neto por item (GUID en minúsculas) de unas respuestas. */
function efectoPorItem(p: PerfilInventario, campos: unknown, estadoID: number | null): Map<string, number> {
  const r = calcularLineas(p, campos, estadoID);
  const salida = new Map<string, number>();
  if (!r.tipo) return salida;
  for (const l of r.lineas) {
    const g = l.producto.toLowerCase();
    salida.set(g, (salida.get(g) ?? 0) + efecto(r.tipo, l.cantidad));
  }
  return salida;
}
