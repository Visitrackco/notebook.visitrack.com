import { Injectable, inject } from '@angular/core';

import { resolveCatalogOwnerId } from '../config/company-rules';
import { AnswerField, FormField, FormPage, parseQuestions } from '../forms/form-schema';
import { ListDefinition, ListDetail } from '../models/entities.model';
import { ListDetailRepository } from '../repositories/entity.repositories';
import { AuthService } from './auth.service';
import { titlesFrom } from './location-editor.service';
import { DataRevisionService } from '../sync/data-revision.service';

/** Lo que hace falta para dar de alta un ítem. */
export interface NewListItem {
  /** Lista a la que pertenece. */
  definition: ListDefinition;

  name: string;
  answers: AnswerField[];

  /** Campos de la lista, para resolver sus descriptivos. */
  fields: FormField[];

  /** Ítem del que cuelga, en las listas encadenadas. */
  parentGuid?: string;

  /** Ubicación y activo con los que se relaciona, si aplica. */
  locationId?: string;
  locationGuid?: string;
  assetId?: string;
}

/**
 * Crear ítems de lista desde donde hagan falta.
 *
 * ## Por qué en cualquier sitio
 *
 * Antes esto solo aparecía en algunos casos del árbol de listas — y no en el
 * resto por cómo estaba escrita la pantalla, no porque tuviera sentido
 * impedirlo. Quien está diligenciando y no encuentra el ítem que necesita tiene
 * el mismo problema venga de un desplegable, de una tabla de detalle o de una
 * lista encadenada: o lo da de alta ahí, o abandona lo que estaba haciendo.
 *
 * Lo único que decide si se puede es **el permiso del rol**. La configuración
 * de la lista dice de dónde salen los ítems, no quién puede añadirlos.
 *
 * ## Qué pasa con lo creado
 *
 * Queda en el dispositivo marcado como creado aquí y pendiente de subir
 * (`CreateWithMovil`, `Save`), igual que en la app. La sincronización lo lleva
 * al servidor después; mientras tanto ya se puede elegir y responder con él.
 */
@Injectable({ providedIn: 'root' })
export class ListItemEditorService {
  private readonly details = inject(ListDetailRepository);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);

  /**
   * El formulario que define los campos de un ítem.
   *
   * Sale de `jsonFields` de la lista, la misma estructura que un formulario. Si
   * la lista no define ninguno, el ítem es solo su nombre — que es un caso
   * legítimo y frecuente.
   */
  schemaOf(definition: ListDefinition | null): FormPage[] {
    return definition ? parseQuestions(definition.jsonFields) : [];
  }

  /** Da de alta el ítem y devuelve el registro guardado. */
  async create(input: NewListItem): Promise<ListDetail> {
    const user = this.auth.currentUser();
    if (!user) throw new Error('No hay una sesión activa.');

    const owner = resolveCatalogOwnerId(user);
    const guid = crypto.randomUUID();
    const listId = String(input.definition.ListIDBD ?? '');

    const record: ListDetail = {
      ID: 0,
      GUID: guid,
      UserID: owner,

      CompanyID: String(user.CompanyID ?? ''),
      ListID: listId,
      ListIDBD: listId,

      Name: input.name,
      Value: '',

      /**
       * Los campos del ítem, con la misma forma que escribe la app.
       *
       * `fie` dentro de un objeto y no un arreglo suelto: es lo que el servidor
       * espera de un ítem creado en el cliente, y lo que los descriptivos saben
       * leer al mostrarlo.
       */
      jsonValues: JSON.stringify({ id: guid, name: input.name, fie: input.answers }),
      JSONTilte: JSON.stringify(titlesFrom(input.fields, (id) => valueOf(input.answers, id))),

      LocationID: input.locationId ?? '',
      LocationGUID: input.locationGuid ?? '',
      AssetID: input.assetId ?? '',
      ItemID: '',

      // De quién cuelga, en las listas encadenadas. Sin esto, un ítem creado
      // desde una lista hija no aparecería bajo su padre.
      ParentGUID: input.parentGuid ?? '',

      TagUID: '',
      RefID: '',
      SurveyAnswerGUID: '',
      FieldID: '',
      ListDetGUID: '',
      ListDetName: '',
      UserIDD: String(owner),

      IsDeleted: 0,
      SyncOn: 0,

      // Creado aquí y sin subir: es lo que mira la sincronización para llevarlo.
      CreateWithMovil: '1',
      Save: '1',
      Upload: '0',
      SyncedToServer: '0',

      CreatedOn: new Date().toISOString(),
      UpdatedOn: new Date().toISOString(),
      VTEntityID: 0,
    } as ListDetail;

    // La llave la ponemos nosotros: el store de ítems no autoincrementa, porque
    // los que bajan del servidor traen el `ID` de Visitrack. Ver
    // [BaseRepository.nextLocalKey].
    record.ID = await this.details.nextLocalKey();

    await this.details.put(record);
    this.revisions.touchEntities();

    return record;
  }
}

/** El valor de un campo entre las respuestas dadas. */
function valueOf(answers: readonly AnswerField[], id: string): unknown {
  return answers.find((answer) => answer.id === id)?.val ?? '';
}
