import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { environment } from '../../../environments/environment';
import { ANSWER_STATE } from '../models/activity.model';
import { SurveyAnswer } from '../models/entities.model';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from '../services/auth.service';
import { SyncService } from '../sync/sync.service';
import { PerfilInventario, calcularLineas, efecto, leerPerfil, numero, tocaMover } from './perfil-inventario';

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
}

/** Lo que se guarda por usuario en `localStorage`. */
interface Guardado {
  firma: string;
  al: string;
  perfiles: unknown[];
  stock: unknown[];
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

  private readonly stock = signal<ReadonlyMap<string, StockDeItem>>(new Map());
  private readonly perfiles = signal<ReadonlyMap<string, PerfilInventario>>(new Map());

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

      const estado = estadoDe(answer);
      if (!tocaMover(perfil, completada, estado)) return NADA;

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

      return { accion: perfil.negativo === 'bloquear' && !yaSubio(answer) ? 'bloquear' : 'avisar', faltantes };
    } catch (error) {
      // Revisar no puede impedir guardar por un error propio.
      console.warn('[inventario] no se pudo revisar el stock', error);
      return NADA;
    }
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
          ? { firma: '', al: '', perfiles: [], stock: [] }
          : {
              firma: String(cuerpo.firma ?? ''),
              al: String(cuerpo.al ?? ''),
              perfiles: Array.isArray(cuerpo.perfiles) ? cuerpo.perfiles : [],
              stock: Array.isArray(cuerpo.stock) ? cuerpo.stock : [],
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
    this.stock.set(stock);
    this.perfiles.set(perfiles);
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
