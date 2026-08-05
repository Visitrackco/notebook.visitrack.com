import { Injectable, inject } from '@angular/core';

import { BinaryResource, BinaryState, BinaryType } from '../models/sync.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from '../services/auth.service';

/** Un archivo con el contexto que hace falta para auditarlo. */
export interface BinaryEntry {
  resource: BinaryResource;
  /** Actividad a la que pertenece, si todavía existe. */
  answerTitle: string;
  answerGuid: string;
  /** Formulario del que salió. */
  surveyId: string;
}

/** Cuántos archivos hay en cada estado. */
export interface BinaryStats {
  total: number;
  online: number;
  inRepository: number;
  pending: number;
  discarded: number;
  unrecoverable: number;
}

/** Filtro del listado. `-1` es «todos». */
export const ALL_STATES = -1;

/** Una página del listado. */
export interface BinaryPage {
  entries: BinaryEntry[];
  /** Total que cumple el filtro, no el de la página. */
  matching: number;
  page: number;
  pages: number;
}

/**
 * Consulta de archivos para la pantalla de auditoría.
 *
 * ## Por qué pagina en memoria
 *
 * IndexedDB pagina con cursores, que es lo correcto para cien mil registros.
 * Aquí el conjunto son los archivos de un usuario —decenas, a lo sumo unos
 * pocos miles— y el filtro cruza dos almacenes: el archivo y la actividad de la
 * que cuelga. Resolver eso con cursores exige mantener índices compuestos que
 * habría que migrar cada vez que cambie un filtro; leer y filtrar en memoria
 * cuesta milisegundos y no ata el esquema a la interfaz.
 *
 * Si algún día el volumen lo justifica, el cambio queda encerrado aquí.
 */
@Injectable({ providedIn: 'root' })
export class BinaryAuditService {
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly auth = inject(AuthService);

  /** Todos los archivos del usuario, con su contexto. */
  async load(): Promise<BinaryEntry[]> {
    const user = this.auth.currentUser();
    if (!user) return [];

    const resources = await this.binaries.query({ index: 'byUserID', range: user.UserID });
    const answers = await this.answers.query({ index: 'byUserID', range: user.UserID });

    const byGuid = new Map(answers.map((answer) => [answer.GUID, answer]));

    const entries = resources.map((resource) => {
      const answer = byGuid.get(resource.AnswerGUID);

      return {
        resource,
        answerGuid: resource.AnswerGUID,
        answerTitle: answer ? describeAnswer(answer.Titles) : 'Actividad eliminada',
        surveyId: answer?.SurveyID ?? '',
      };
    });

    // Lo más reciente primero: un archivo recién capturado es el que se viene a
    // mirar cuando algo no cuadra.
    return entries.sort((a, b) => Number(b.resource.tim ?? 0) - Number(a.resource.tim ?? 0));
  }

  /** Aplica filtros y devuelve una página. */
  paginate(
    entries: readonly BinaryEntry[],
    options: { state: number; search: string; page: number; size: number },
  ): BinaryPage {
    const search = options.search.trim().toLowerCase();

    const matching = entries.filter((entry) => {
      if (options.state !== ALL_STATES && entry.resource.BinaryState !== options.state) {
        return false;
      }

      if (!search) return true;

      return (
        entry.answerTitle.toLowerCase().includes(search) ||
        entry.resource.GUID.toLowerCase().includes(search) ||
        (entry.resource.Ext ?? '').toLowerCase().includes(search)
      );
    });

    const pages = Math.max(1, Math.ceil(matching.length / options.size));
    const page = Math.min(Math.max(0, options.page), pages - 1);
    const start = page * options.size;

    return {
      entries: matching.slice(start, start + options.size),
      matching: matching.length,
      page,
      pages,
    };
  }

  /** Recuento por estado. Se calcula sobre el total, no sobre el filtro. */
  stats(entries: readonly BinaryEntry[]): BinaryStats {
    const count = (state: BinaryState) =>
      entries.filter((entry) => entry.resource.BinaryState === state).length;

    return {
      total: entries.length,
      online: count(BinaryState.Online),
      inRepository: count(BinaryState.InRepository),
      pending: count(BinaryState.Pending),
      discarded: count(BinaryState.Discarded),
      unrecoverable: count(BinaryState.Unrecoverable),
    };
  }
}

/** Nombre legible de un estado. */
export function describeBinaryState(state: BinaryState): {
  label: string;
  detail: string;
  tone: 'success' | 'info' | 'warning' | 'danger';
} {
  switch (state) {
    case BinaryState.Online:
      return {
        label: 'En línea',
        detail: 'Confirmado en el servidor de archivos. Su actividad ya puede enviarse.',
        tone: 'success',
      };
    case BinaryState.InRepository:
      return {
        label: 'En servidor',
        detail:
          'El servidor lo recibió y está esperando a publicarse. Suele tardar cerca de un minuto.',
        tone: 'info',
      };
    case BinaryState.Discarded:
      return {
        label: 'Descartado',
        detail:
          'El servidor no pudo clasificarlo y nunca se publicará. No impide enviar la actividad.',
        tone: 'danger',
      };
    case BinaryState.Unrecoverable:
      return {
        label: 'No disponible',
        detail:
          'El archivo ya no está en este dispositivo y nunca llegó al servidor. Se perdió.',
        tone: 'danger',
      };
    default:
      return {
        label: 'Pendiente',
        detail: 'Solo está en este dispositivo. Falta subirlo al servidor.',
        tone: 'warning',
      };
  }
}

/** Nombre legible de un tipo de archivo. */
export function describeBinaryType(type: BinaryType): { label: string; icon: string } {
  switch (type) {
    case BinaryType.Signature:
      return { label: 'Firma', icon: 'user' };
    case BinaryType.Video:
      return { label: 'Video', icon: 'video' };
    case BinaryType.Audio:
      return { label: 'Audio', icon: 'mic' };
    case BinaryType.File:
      return { label: 'Documento', icon: 'file' };
    default:
      return { label: 'Fotografía', icon: 'image' };
  }
}

/**
 * Resume la actividad a partir de su columna de descriptivos.
 *
 * Llega como JSON y puede venir vacía o mal formada —una actividad sin campos
 * descriptivos, o guardada por una versión anterior—, así que un fallo aquí
 * devuelve un texto neutro en vez de romper la pantalla entera.
 */
function describeAnswer(titles: string): string {
  if (!titles?.trim()) return 'Actividad sin descriptivos';

  try {
    const parsed = JSON.parse(titles);
    const values = Array.isArray(parsed)
      ? parsed.map((item) => String(item?.val ?? '')).filter(Boolean)
      : [];

    return values.length > 0 ? values.slice(0, 2).join(' · ') : 'Actividad sin descriptivos';
  } catch {
    return 'Actividad sin descriptivos';
  }
}
