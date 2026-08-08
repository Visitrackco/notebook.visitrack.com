import { Injectable, inject } from '@angular/core';

import { environment } from '../../../environments/environment';
import { parseAnswerFields } from '../forms/form-schema';
import { readRows } from '../forms/master-detail';
import { BinaryResource, BinaryState, BinaryType } from '../models/sync.model';
import { SurveyAnswer } from '../models/entities.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from '../services/auth.service';
import { DatabaseService } from '../database/database.service';
import { BinaryData } from '../models/sync.model';
import { DataRevisionService } from './data-revision.service';

/** Un archivo referenciado por una consigna. */
export interface DispatchFile {
  /** GUID del archivo en el servidor. */
  guid: string;
  /** Consigna que lo referencia. */
  answerGuid: string;
  /** Campo del formulario donde está. */
  fieldId: string;
  type: BinaryType;
  /** Dirección desde la que se puede ver o descargar. */
  url: string;
}

/**
 * Qué recurso pide cada tipo de archivo a la plataforma.
 *
 * Los nombres son los que entiende `WebResource.aspx`. Ya no es el camino
 * principal —ver [DispatchFilesService.urlOf]— pero sigue sirviendo para abrir
 * un archivo en una pestaña cuando el puente no lo tiene.
 */
const RESOURCE: Record<number, string> = {
  [BinaryType.Image]: 'PICTURE',
  [BinaryType.Signature]: 'PICTURE',
  [BinaryType.Video]: 'VIDEO',
  [BinaryType.Audio]: 'AUDIO',
  [BinaryType.File]: 'FILE',
};

/** De qué tipo es el archivo, según el campo que lo contiene. */
const TYPE_BY_FIELD: Record<string, BinaryType> = {
  picture: BinaryType.Image,
  image: BinaryType.Image,
  signature: BinaryType.Signature,
  video: BinaryType.Video,
  audio: BinaryType.Audio,
  file: BinaryType.File,
};

/**
 * Los archivos que traen las consignas.
 *
 * ## Qué problema resuelve
 *
 * Una consigna puede llegar con fotografías, firmas o documentos adjuntos desde
 * la plataforma: el plano de la sede, la foto del daño reportado, la orden
 * firmada. Sin esto, esos archivos existen en el servidor pero no hay forma de
 * verlos ni de llevárselos.
 *
 * ## Estos archivos no se suben
 *
 * Vienen **del** servidor, así que subirlos sería devolverle lo que ya tiene —y
 * cada intento consumiría datos y podría duplicarlos. Se registran con el estado
 * de «confirmado en el bucket», que es el que el proceso de subida ignora, y
 * además quedan marcados con `Origin: 'server'` para que la auditoría de
 * archivos no los confunda con los capturados aquí.
 *
 * ## La copia local es un intento, no una promesa
 *
 * Se procura descargar el contenido para poder verlo y guardarlo sin conexión.
 * Puede no lograrse —el servidor de archivos tiene que permitir la petición
 * desde este origen—, y en ese caso el registro se conserva igual con su
 * dirección: el usuario puede abrirla y descargarla desde el navegador. Un
 * archivo al que se llega en un clic es mejor que ninguno.
 */
@Injectable({ providedIn: 'root' })
export class DispatchFilesService {
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly auth = inject(AuthService);
  private readonly db = inject(DatabaseService);
  private readonly revisions = inject(DataRevisionService);

  /**
   * Registra y descarga los archivos de todas las consignas.
   *
   * Lo llama la sincronización al terminar. Es idempotente: los que ya están
   * registrados no se vuelven a pedir, así que repetirlo no cuesta nada.
   *
   * @returns cuántos archivos nuevos quedaron con su contenido guardado.
   */
  async syncAll(): Promise<number> {
    const user = this.auth.currentUser();
    if (!user) return 0;

    try {
      const answers = await this.answers.findByUser(String(user.UserID));
      const dispatches = answers.filter((answer) => answer.Sheduled === '1');

      let saved = 0;

      for (const answer of dispatches) {
        saved += await this.syncOne(answer);
      }

      if (saved > 0) this.revisions.touchBinaries();

      return saved;
    } catch (error) {
      console.error('[Consignas] no se pudieron traer los archivos', error);
      return 0;
    }
  }

  /** Lo mismo para una sola consigna. */
  async syncOne(answer: SurveyAnswer): Promise<number> {
    const user = this.auth.currentUser();
    if (!user) return 0;

    const files = this.filesOf(answer);
    if (files.length === 0) return 0;

    /**
     * Lo ya registrado, por GUID.
     *
     * Se guarda el registro entero y no solo el identificador porque hacen
     * falta dos cosas de él: si **ya tiene contenido**, y su `ID` para no
     * duplicarlo al volver a escribirlo.
     */
    const known = new Map(
      (await this.binaries.findByAnswer(answer.GUID)).map((binary) => [binary.GUID, binary]),
    );

    let saved = 0;

    for (const file of files) {
      const previous = known.get(file.guid);

      /**
       * Se reintenta lo que quedó registrado sin contenido.
       *
       * Antes bastaba con que el GUID estuviera registrado para saltarlo, y eso
       * dejaba el archivo condenado: el primer intento —cuando el servidor
       * todavía no dejaba leerlo— creaba la ficha vacía, y a partir de ahí
       * ninguna sincronización volvía a intentarlo. Se veía como «bajó 0» para
       * siempre, sin forma de salir de ahí salvo borrando los datos del sitio.
       *
       * `base` es lo que dice que el contenido está guardado de verdad.
       */
      if (previous?.base) continue;

      const blob = await this.fetchBlob(file);

      // Con el `ID` del registro anterior, si lo había: sin él, IndexedDB
      // asigna una llave nueva y cada reintento dejaría una ficha duplicada.
      const record = this.recordOf(file, user.UserID, blob);
      if (previous?.ID != null) record.ID = previous.ID;

      await this.binaries.put(record);

      if (blob) {
        await this.storeBlob(file.guid, blob);
        saved++;
      }
    }

    return saved;
  }

  /**
   * Los archivos que referencia una consigna.
   *
   * Se recorren también las filas de sus tablas de detalle: una consigna con
   * diez equipos puede traer una foto por equipo, y quedarse en el primer nivel
   * dejaría fuera casi todo.
   */
  filesOf(answer: SurveyAnswer): DispatchFile[] {
    const found: DispatchFile[] = [];
    const seen = new Set<string>();

    const walk = (fields: unknown): void => {
      for (const entry of parseAnswerFields(fields)) {
        /**
         * El tipo se normaliza y **no decide** si hay archivo.
         *
         * Antes sí: se miraba `TYPE_BY_FIELD[entry.fty]` y solo entonces se
         * buscaba el GUID. Con eso, una consigna cuyo `fty` viniera con otra
         * grafía —o sin venir— no aportaba ni un archivo, aunque su valor
         * llevara el binario delante. Es lo que pasaba con las firmas.
         *
         * El `fty` de una respuesta lo escribe quien la creó, y una consigna la
         * crea la plataforma, no esta aplicación: no se le puede exigir una
         * grafía concreta. Lo que sí es inequívoco es la **forma del valor**,
         * porque `bin` solo aparece en los campos de archivo.
         */
        const fty = String(entry.fty ?? '').toLowerCase();

        // Una tabla de detalle primero: su valor es un arreglo de filas, y cada
        // fila lleva sus propias respuestas —con sus propios archivos— dentro.
        if (fty === 'masterdetail' || Array.isArray(entry.val)) {
          for (const row of readRows(entry.val)) walk(row.JSONValues ?? []);
          continue;
        }

        const guid = binaryGuidOf(entry, fty);
        if (!guid || seen.has(guid)) continue;

        seen.add(guid);

        /**
         * Sin `fty` reconocible se asume imagen.
         *
         * No es una suposición arriesgada: el tipo solo sirve para acotar con
         * qué extensiones buscar el archivo, y la lista de imágenes cubre
         * también las firmas —png y jpg—, que es el caso que llega sin tipo.
         */
        const type = TYPE_BY_FIELD[fty] ?? BinaryType.Image;

        found.push({
          guid,
          answerGuid: answer.GUID,
          fieldId: entry.id,
          type,
          url: this.urlOf(guid, type),
        });
      }
    };

    walk(answer.Fields);

    /**
     * Una consigna sin archivos detectados se deja anotada.
     *
     * No es lo mismo «no trae» que «no se supo leer», y desde fuera se ven
     * igual. El `fty` y la forma del valor los escribe la plataforma, no esta
     * aplicación, y cuando cambian no hay forma de enterarse salvo mirando el
     * dato real. Esto lo pone a la vista sin tener que instrumentar nada.
     */
    if (found.length === 0) {
      const shapes = parseAnswerFields(answer.Fields).map((entry) => ({
        id: entry.id,
        fty: entry.fty,
        val: typeof entry.val,
        claves:
          entry.val && typeof entry.val === 'object' ? Object.keys(entry.val) : undefined,
        val1: entry.val1 ? Object.keys(entry.val1) : undefined,
      }));

      if (shapes.length > 0) {
        console.debug('[Consignas] sin archivos detectados en', answer.GUID, shapes);
      }
    }

    return found;
  }

  /**
   * Dirección desde la que se lee un archivo del servidor.
   *
   * Va contra el puente de la API y no contra el servidor de archivos de la
   * plataforma. La razón no es de gusto: el navegador **no puede leer** una
   * respuesta de otro dominio que no lo autorice, y ese servidor no lo hace.
   * Con `<img src>` la foto se vería, pero no habría forma de guardarla en el
   * equipo ni de tenerla sin conexión — que es exactamente lo que se le pide a
   * una consigna con fotos.
   *
   * El puente lee del bucket desde el servidor, donde esa restricción no
   * existe, y reenvía. Además resuelve la extensión: una consigna trae el GUID
   * del archivo, pero no con qué extensión quedó guardado.
   */
  urlOf(guid: string, type: BinaryType): string {
    const base = environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;

    return `${base}/dispatchFile?id=${encodeURIComponent(guid)}&type=${type}`;
  }

  /**
   * La dirección de la plataforma, para abrirla en una pestaña.
   *
   * Es el respaldo de cuando el puente no da el archivo —no está desplegado
   * todavía, o no está en el bucket—. Abrir una pestaña no está sujeto a la
   * restricción de origen, así que el usuario ve su archivo aunque la
   * aplicación no haya podido guardarlo.
   */
  legacyUrlOf(guid: string, type: BinaryType): string {
    const resource = RESOURCE[type] ?? 'PICTURE';

    return `${environment.binariesUrl}?e=${resource}&id=${encodeURIComponent(guid)}`;
  }

  /**
   * El contenido guardado, si se pudo traer.
   *
   * `null` cuando el archivo solo existe en el servidor: quien lo enseñe debe
   * caer entonces en su dirección.
   */
  async localUrl(guid: string): Promise<string | null> {
    try {
      const data = await this.db.transaction('BinariesData', 'readonly', (tx) =>
        this.db.request<BinaryData | undefined>(tx.objectStore('BinariesData').get(guid)),
      );

      return data?.blob ? URL.createObjectURL(data.blob) : null;
    } catch {
      return null;
    }
  }

  /**
   * Guarda un archivo en el equipo.
   *
   * Con el contenido descargado se entrega directamente; sin él se abre su
   * dirección, y el navegador se encarga. Lo segundo abre una pestaña —no hay
   * forma de forzar la descarga de otro dominio— pero llega al mismo sitio.
   */
  async saveToDisk(file: DispatchFile, name?: string): Promise<void> {
    const local = await this.localUrl(file.guid);

    if (!local) {
      // Sin copia local se abre en una pestaña, y con la dirección de la
      // plataforma: si el puente no pudo dar el archivo, pedírselo otra vez
      // daría el mismo resultado, y la plataforma sí sabe resolverlo por
      // identificador.
      window.open(this.legacyUrlOf(file.guid, file.type), '_blank', 'noopener');
      return;
    }

    const link = document.createElement('a');
    link.href = local;
    link.download = name || file.guid;
    link.click();

    // La URL se revoca en el siguiente ciclo: revocarla antes cancelaría la
    // descarga que se acaba de pedir.
    setTimeout(() => URL.revokeObjectURL(local), 10_000);
  }

  // ── Interno ────────────────────────────────────────────────────────────────

  private async fetchBlob(file: DispatchFile): Promise<Blob | null> {
    try {
      const response = await fetch(file.url, { credentials: 'omit' });
      if (!response.ok) return null;

      const blob = await response.blob();

      // Un servidor que devuelve la página de inicio de sesión responde 200 con
      // un HTML: guardarlo dejaría una «foto» que al abrirse no es una foto.
      return blob.type.startsWith('text/html') ? null : blob;
    } catch (error) {
      /**
       * Se anota, pero no se interrumpe nada.
       *
       * Antes se callaba porque lo esperable era que el servidor de archivos no
       * autorizara la petición y no había nada que hacer al respecto. Con el
       * puente sí lo hay: si esto falla, es que el puente no responde o no
       * tiene el archivo, y eso hay que poder verlo sin instrumentar nada.
       */
      console.debug('[Consignas] no se pudo traer el archivo', file.url, error);
      return null;
    }
  }

  private async storeBlob(guid: string, blob: Blob): Promise<void> {
    await this.db.transaction('BinariesData', 'readwrite', (tx) =>
      this.db.request(
        tx.objectStore('BinariesData').put({
          GUID: guid,
          blob,
          mimeType: blob.type || 'application/octet-stream',
          createdAt: new Date().toISOString(),
        } satisfies BinaryData),
      ),
    );
  }

  private recordOf(file: DispatchFile, userId: string, blob: Blob | null): BinaryResource {
    return {
      base: blob ? file.guid : '',
      GUID: file.guid,
      TypeBinarie: file.type,
      TypeID: 1,

      /**
       * Marcado como ya confirmado en el bucket.
       *
       * Es el estado que el proceso de subida no toca —solo recoge los
       * pendientes—, y es cierto: el archivo está en el servidor porque de ahí
       * vino.
       */
      Uploaded: 1,
      IsSync: 1,
      BinaryState: BinaryState.Online,
      VerifyAttempts: 0,
      VerifiedOn: new Date().toISOString(),

      AnswerGUID: file.answerGuid,
      IDField: file.fieldId,
      Lat: '',
      Lng: '',
      tim: String(Date.now()),
      UserID: userId,
      Ext: extensionOf(blob),
      Size: String(blob?.size ?? 0),

      // Lo que lo distingue de lo capturado aquí. Ver la nota de la clase.
      Origin: 'server',
    };
  }
}

/**
 * El identificador del archivo dentro de una respuesta.
 *
 * Vive en `val1.bin` en los tipos que desdoblan el valor —fotos, videos— y en
 * `val` a secas en los demás. Se miran los dos porque una consigna puede traer
 * ambas formas según cómo la escribiera quien la generó.
 */
/** Un identificador de archivo con forma de GUID. */
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El GUID del archivo que guarda una respuesta, si guarda alguno.
 *
 * Hay tres formas y la aplicación tiene que leer las tres, porque así es como
 * el backend las recibe desde hace años:
 *
 * 1. **`picture`, `audio`, `video`** — el GUID en `val` y la ficha completa en
 *    `val1`.
 * 2. **`signature`, `file`** — la ficha va **directamente en `val`**, y `val1`
 *    ni existe. Este era el caso que se perdía: se buscaba primero por `fty`,
 *    y si el tipo no coincidía nunca se llegaba a mirar la forma del valor.
 * 3. Solo el GUID suelto en `val`, sin ficha.
 *
 * Las dos primeras se reconocen por la forma —`bin` solo aparece en un campo de
 * archivo— así que no dependen de `fty`. La tercera sí lo exige: una cadena
 * suelta con forma de GUID podría ser cualquier cosa, y tratarla como archivo
 * llenaría la consigna de descargas inexistentes.
 */
function binaryGuidOf(entry: { val?: unknown; val1?: unknown }, fty: string): string {
  const nested = (entry.val1 as { bin?: unknown } | null)?.bin;
  if (typeof nested === 'string' && nested) return nested;

  const inline = (entry.val as { bin?: unknown } | null)?.bin;
  if (typeof inline === 'string' && inline) return inline;

  if (typeof entry.val === 'string' && TYPE_BY_FIELD[fty]) {
    const value = entry.val.trim();
    if (GUID_PATTERN.test(value)) return value;
  }

  return '';
}

/** La extensión, deducida del contenido. Vacía si no se pudo descargar. */
function extensionOf(blob: Blob | null): string {
  if (!blob) return '';

  const type = blob.type.toLowerCase();

  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('webm')) return 'webm';
  if (type.includes('pdf')) return 'pdf';

  return '';
}
