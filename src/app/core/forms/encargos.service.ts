/**
 * Lo que el flujo pidió hacer **con la actividad**, ejecutado.
 *
 * El motor no crea actividades, ni despacha, ni manda correos: deja encargos.
 * Aquí se ejecutan, y aquí y no en la pantalla del formulario porque hay dos
 * quienes los ejecutan: el formulario al guardar, y el padre que reacciona a
 * un hijo **sin abrirse** (ver `ParientesService.avisarAlPadre`). Con el
 * código en la pantalla, el padre solo podía cambiar de estado y escribir
 * campos; todo lo demás —crear una actividad, despachar, avisar, guardar
 * ahora mismo— se quedaba sin hacer.
 *
 * Lo que sigue en la pantalla es lo que necesita a alguien delante: preguntar
 * a quién se despacha, enseñar avisos, salir.
 */
import { Injectable, inject } from '@angular/core';

import { Survey, SurveyAnswer } from '../models/entities.model';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ActivityService } from '../services/activity.service';
import { AuthService } from '../services/auth.service';
import { BinaryStorageService } from '../services/binary-storage.service';
import { CorreoService } from '../services/correo.service';
import { DespachoService } from '../services/despacho.service';
import { PushFlujoService } from '../services/push-flujo.service';
import { PendingUploadService } from '../sync/pending-upload.service';
import { FormEngine } from './form-engine';
import { EncargoDeHijo, HerenciaDeActividad, Momento } from './flujo-modelo';
import {
  AnswerField,
  FieldValue,
  FormField,
  fileValueOf,
  parseAnswerFields,
  parseQuestions,
  splitFileValue,
} from './form-schema';
import { comoLoGuarda } from './flujo-motor';
import { LinkedFormService } from './linked-form.service';
import { readRows } from './master-detail';
import { ParientesService, esVinculado } from './parientes.service';

/** La llave con la que se recuerda a quién va cada consigna pedida. */
export function claveDeDespacho(d: Record<string, unknown>): string {
  // Con la programación dentro: una misma regla puede pedir dos consignas del
  // mismo formulario para dos fechas distintas, y cada una puede ir a alguien
  // distinto. Sin ella, la segunda heredaba el destinatario de la primera.
  return [d['regla'] ?? '', d['que'] ?? '', d['formulario'] ?? '', d['programado'] ?? ''].join('|');
}

@Injectable({ providedIn: 'root' })
export class EncargosDelFlujoService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly activities = inject(ActivityService);
  private readonly auth = inject(AuthService);
  private readonly binaryStorage = inject(BinaryStorageService);
  private readonly despachos = inject(DespachoService);
  private readonly correos = inject(CorreoService);
  private readonly pushes = inject(PushFlujoService);
  private readonly pendingUploads = inject(PendingUploadService);
  private readonly linked = inject(LinkedFormService);
  private readonly parientes = inject(ParientesService);

  /**
   * Todo lo que el flujo pidió sobre la actividad, de una vez y en el orden
   * de siempre: crear las actividades pedidas, apuntar consignas, correos y
   * notificaciones, y ejecutar lo de los hijos. El estado y el timer los
   * escribe quien llama, que es quien tiene la actividad en la mano.
   */
  async ejecutarTodo(
    engine: FormEngine,
    answer: SurveyAnswer,
    survey: Survey,
    opciones: { incompleta?: boolean; momento?: Momento; elegidos?: ReadonlyMap<string, string> } = {},
  ): Promise<string[]> {
    const incompleta = opciones.incompleta ?? false;

    const creadas = await this.crearLasQuePidioElFlujo(engine, answer);
    await this.apuntarLasConsignas(engine, answer, incompleta, opciones.elegidos);
    await this.apuntarLosCorreos(engine, answer, incompleta);
    await this.apuntarLosPushes(engine, answer, incompleta);
    await this.aplicarEncargosDeHijos(engine, answer, survey, opciones.momento ?? 'guardar');

    return creadas;
  }

  /**
   * Guardar la actividad **sin nadie delante**: es `guardar-actividad`
   * ejecutado sobre un padre que reacciona a un hijo.
   *
   * Lo mismo que hace la pantalla al guardar, sin lo que necesita pantalla:
   * se sella como guardada —completada solo si no le faltan obligatorios—,
   * entra en la cola de subida y salen las consignas y los correos que
   * estuvieran apuntados.
   */
  async guardarSinPantalla(engine: FormEngine, answer: SurveyAnswer): Promise<void> {
    if (answer.ID == null) return;

    const incompleta = engine.missing().length > 0;
    const pendientes = await this.activities.countBlockingBinaries(answer.GUID);
    const completedOn = incompleta ? '' : answer.CompletedOn || new Date().toISOString();

    await this.answers.markSaved(answer.ID, pendientes > 0, completedOn);
    this.activities.notifyChanged();

    await this.enviar(answer.GUID);
  }

  /** La subida y lo que sale con ella. Ver `dispatch` en la pantalla. */
  async enviar(guid: string): Promise<void> {
    /*
     * Si la cola ya está subiendo otra cosa —lo normal: el hijo que acaba de
     * guardarse todavía está subiendo cuando el padre reacciona— `run`
     * vuelve sin hacer nada, y el padre se quedaba marcado como pendiente
     * hasta la siguiente vuelta. Se espera a que la cola quede libre (hasta
     * un minuto) y entonces se sube.
     */
    for (let espera = 0; this.pendingUploads.running() && espera < 120; espera++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      await this.pendingUploads.run(guid);
    } catch (error) {
      console.error('[flujo] no se pudo enviar la actividad', error);
    }

    await this.despachos.enviarPendientes(guid);
    await this.correos.encolarPendientes(guid);
    await this.pushes.encolarPendientes(guid);
  }

  /**
   * Lo que el flujo pidió sobre los hijos al guardar.
   *
   * Cada encargo llega por su campo vinculado: crear la hija si no existe y
   * dejar el enlace en el campo —como si se hubiera pulsado «diligenciar»—,
   * sembrarle los campos que se eligieron, cambiarle el estado o eliminarla.
   * Lo que se siembra viene ya leído del padre; sembrar es el mismo código
   * que usa «crear una actividad».
   */
  async aplicarEncargosDeHijos(
    engine: FormEngine,
    answer: SurveyAnswer,
    survey: Survey,
    momento: Momento = 'guardar',
  ): Promise<void> {
    const encargos = engine.encargosDeHijosAlGuardar(momento);

    /*
     * Que se vea qué pidió el flujo y qué pasó con cada cosa.
     *
     * «La regla se disparó y no creó nada» tiene cuatro causas que desde fuera
     * se ven igual: que el encargo no llegara, que el campo vinculado no se
     * encontrara, que el formulario hijo no esté descargado, o que la hija ya
     * existiera. Sin esto hay que ir descartándolas a ciegas.
     */
    console.log('[flujo] hijos al guardar:', {
      encargos: encargos.map((e) => `${e.que} → ${(e.valor as EncargoDeHijo)?.vinculado}`),
      vinculados: engine.pages
        .flatMap((p) => p.fie)
        .filter((f) => esVinculado(f.fty))
        .map((f) => `${(f.apiId ?? '').toString().trim() || f.id} (fid ${f.fid ?? '?'})`),
    });

    if (!encargos.length || answer.ID == null) return;

    // Los que escriben en un hijo que ya existe, por el camino que ya había.
    const antiguos = encargos.filter((e) => e.que === 'escribir-en-hijo');
    if (antiguos.length) await this.parientes.ejecutar(answer, survey, antiguos);

    const vinculados = engine.pages.flatMap((p) => p.fie).filter((f) => esVinculado(f.fty));
    let tocado = false;

    for (const encargo of encargos) {
      if (encargo.que === 'escribir-en-hijo') continue;

      const pedido = encargo.valor as EncargoDeHijo;
      const campo = vinculados.find((f) => ((f.apiId ?? '').toString().trim() || f.id) === pedido?.vinculado);
      if (!campo) {
        console.warn('[flujo] el encargo apunta a un campo vinculado que no existe', pedido?.vinculado);
        continue;
      }

      try {
        const valorActual = engine.valueOf(campo.id);
        const { answer: hijo, survey } = await this.linked.resolve(String(campo.fid ?? ''), valorActual);

        if (!survey) {
          console.warn('[flujo] el formulario hijo no está descargado en este navegador', campo.fid);
          continue;
        }

        console.log(`[flujo] ${encargo.que} sobre «${pedido.vinculado}»: ${hijo ? 'la hija ya existe' : 'sin hija todavía'}`);

        const herencia: HerenciaDeActividad = {
          formulario: String(survey.SurveyID),
          campos: (pedido.campos ?? []).map((c) => ({ campo: c.campo, valor: c.valor })),
          tablas: pedido.tablas ?? [],
          binarios: pedido.binarios ?? [],
        };
        const hayHerencia = !!(herencia.campos?.length || herencia.tablas?.length || herencia.binarios?.length);

        // Heredar con «crear si falta» es crear: la hija nace con los campos.
        const crea = encargo.que === 'crear-hijo' || (encargo.que === 'heredar-al-hijo' && pedido.crearSiFalta === true);

        if (crea) {
          if (hijo) {
            if (hayHerencia) await this.sembrarHerencia(hijo, survey, answer, survey, herencia);
            continue;
          }

          const padre = (await this.answers.findByGuid(answer.GUID)) ?? answer;
          const creada = await this.linked.create(padre, survey, valorActual, campo.id);
          if (!creada) {
            console.warn('[flujo] no se pudo crear la hija (¿sin sesión?)');
            continue;
          }
          console.log('[flujo] hija creada', creada.answer.GUID);

          // El enlace queda en el campo, como si se hubiera pulsado «diligenciar».
          engine.setValue(campo, creada.value as unknown as FieldValue);
          await this.answers.update(answer.ID, { Fields: JSON.stringify(engine.toAnswerFields()) });

          if (hayHerencia) await this.sembrarHerencia(creada.answer, survey, padre, survey, herencia);
          tocado = true;
          continue;
        }

        if (!hijo) continue;

        if (encargo.que === 'heredar-al-hijo') {
          await this.sembrarHerencia(hijo, survey, answer, survey, herencia);
          tocado = true;
        } else if (encargo.que === 'cambiar-estado-hijo') {
          const estado = String(pedido.estado ?? '').trim();
          if (estado && hijo.ID != null && String(hijo.Status ?? '') !== estado) {
            await this.answers.update(hijo.ID, { Status: estado, UpdatedOn: new Date().toISOString() });
            tocado = true;
          }
        } else if (encargo.que === 'eliminar-hijo') {
          await this.answers.remove(hijo);
          engine.setValue(campo, null);
          await this.answers.update(answer.ID, { Fields: JSON.stringify(engine.toAnswerFields()) });
          tocado = true;
        }
      } catch (error) {
        console.error('[flujo] no se pudo ejecutar el encargo sobre el hijo', encargo.que, error);
      }
    }

    if (tocado) this.activities.notifyChanged();
  }

  /**
   * Abre las actividades que el flujo pidió crear.
   *
   * ## Qué se hereda y qué no
   *
   * La sede y el equipo se copian **solo si el formulario destino los pide del
   * mismo tipo**. Copiarlos siempre dejaría una actividad apuntando a una sede
   * que su formulario no admite, y eso llega a Visitrack como un registro
   * válido que nadie puede cuadrar después. Cuando no encajan se deja en blanco
   * y quien la abra los elige, que es lo que haría de todos modos.
   *
   * Se comparan los dos formularios entre sí y no el formulario con la
   * actividad: en la actividad el tipo de sede se guarda como GUID y en el
   * formulario como número, así que compararlos no daría igual nunca.
   *
   * Nace como borrador y colgando de la que la creó, para que se sepa de dónde
   * salió: una actividad que aparece sola en el listado sin que nadie la haya
   * pedido desconcierta.
   */
  async crearLasQuePidioElFlujo(engine: FormEngine, answer: SurveyAnswer): Promise<string[]> {
    const destinos = engine.actividadesQuePideElFlujo();
    if (!destinos.length) return [];

    const user = this.auth.currentUser();
    if (!user) return [];

    const deOrigen = await this.activities.findSurvey(answer.SurveyID);
    const abiertas: string[] = [];

    for (const pedida of destinos) {
      const destino = pedida.formulario;
      const survey = await this.activities.findSurvey(destino);

      // Un formulario que no está descargado no se puede abrir. Se dice y no
      // se crea: una actividad de un formulario que no existe no se puede ni
      // diligenciar ni borrar con sentido.
      if (!survey) {
        console.warn('[FormRunner] el flujo pidió un formulario que no está descargado', destino);
        continue;
      }

      const mismaSede =
        !!deOrigen &&
        String(survey.LocationTypeID ?? '') === String(deOrigen.LocationTypeID ?? '') &&
        !!answer.LocationID;

      const mismoEquipo =
        !!deOrigen &&
        Number(survey.hasAsset) === 1 &&
        String(survey.AssetTypeID ?? '') === String(deOrigen.AssetTypeID ?? '') &&
        !!answer.AssetID;

      try {
        const nueva = await this.answers.createDraft({
          survey,
          userId: user.UserID,
          companyId: user.CompanyID,
          parentGuid: answer.GUID,
        });

        if ((mismaSede || mismoEquipo) && nueva.ID != null) {
          await this.answers.update(nueva.ID, {
            ...(mismaSede
              ? {
                  LocationTypeID: answer.LocationTypeID,
                  LocationID: answer.LocationID,
                  LocationGUID: answer.LocationGUID,
                  LocationName: answer.LocationName,
                  WorkZoneID: answer.WorkZoneID,
                }
              : {}),
            ...(mismoEquipo
              ? {
                  AssetID: answer.AssetID,
                  AssetGUID: answer.AssetGUID,
                  AssetName: answer.AssetName,
                }
              : {}),
          });
        }

        // Y lo que la regla quiso que llegara escrito. Después de crearla y no
        // dentro: una hija que nace bien y no consigue heredar algo sigue
        // siendo una actividad útil, y atar las dos cosas dejaría sin actividad
        // a quien configuró mal una herencia.
        await this.sembrarHerencia(nueva, survey, answer, deOrigen, pedida);

        abiertas.push(survey.Title);
      } catch (error) {
        console.error('[FormRunner] no se pudo abrir la actividad del flujo', error);
      }
    }

    if (abiertas.length) this.activities.notifyChanged();

    return abiertas;
  }

  /**
   * Deja escrito en la actividad hija lo que el flujo quiso heredar.
   *
   * Los identificadores del encargo son `apiId` de **los dos** formularios: el
   * del hijo en `campo`/`tabla` y el del padre en `de`. Se traducen aquí contra
   * los dos esquemas, porque una respuesta se guarda por el identificador
   * interno y ese es propio de cada formulario.
   *
   * ## Lo que todavía no hace aquí
   *
   * Llenar una tabla del hijo **con registros de una lista** y heredar
   * archivos. Lo primero necesita resolver la lista de una tabla que no está
   * abierta —de eso vive `MasterDetailSourceService`, y trabaja sobre el
   * formulario en pantalla—; lo segundo, copiar ficheros, que en el navegador
   * no es lo mismo que en el teléfono. Se dice en la consola en vez de
   * callarse: una foto que parece heredada y no llega es peor que no heredarla.
   */
  async sembrarHerencia(
    hija: SurveyAnswer,
    survey: Survey,
    padre: SurveyAnswer,
    surveyPadre: Survey | null | undefined,
    herencia: HerenciaDeActividad,
  ): Promise<void> {
    if (hija.ID == null) return;

    const campos = herencia.campos ?? [];
    const tablas = herencia.tablas ?? [];
    const binarios = herencia.binarios ?? [];

    if (!campos.length && !tablas.length && !binarios.length) return;

    try {
      const delHijo = this.camposPorApiId(survey);
      const delPadre = this.camposPorApiId(surveyPadre);

      // Lo respondido en el padre, por el identificador con el que lo guardó.
      const respuestas = new Map(
        parseAnswerFields(padre.Fields).map((entrada) => [entrada.id, entrada]),
      );

      const entradas: AnswerField[] = [];

      for (const pedido of campos) {
        const campo = delHijo.get(String(pedido.campo ?? '').trim());

        if (!campo) {
          console.warn('[flujo] el formulario hijo no tiene el campo', pedido.campo);
          continue;
        }

        /*
         * El motor deja el valor **como texto** porque no conoce el esquema del
         * hijo. Aquí sí se conoce, así que se convierte en lo que ese campo
         * guarda de verdad: un radio `{id, txt}`, una casilla una lista de eso.
         */
        const valor = comoLoGuarda(pedido.valor, {
          // Hay esquemas viejos sin `apiId`; ahí el identificador interno hace
          // de nombre, igual que en el desplegable del lienzo.
          apiId: campo.apiId ?? campo.id,
          fty: campo.fty,
          opt: campo.opt ?? [],
        });

        if (valor === null) {
          console.warn('[flujo] el campo no admite ese valor', pedido.campo, pedido.valor);
          continue;
        }

        entradas.push({
          id: campo.id,
          val: valor as FieldValue,
          fty: campo.fty,
          hid: !!campo.hid,
        });
      }

      for (const pedida of tablas) {
        const tablaHija = delHijo.get(String(pedida.tabla ?? '').trim());

        if (!tablaHija || tablaHija.fty !== 'masterdetail') {
          console.warn('[flujo] el formulario hijo no tiene la tabla', pedida.tabla);
          continue;
        }

        if (pedida.items?.length) {
          console.warn(
            '[flujo] llenar con registros de una lista una tabla de la actividad hija ' +
              'todavía solo funciona en la app',
            pedida.tabla,
          );
        }

        const de = String(pedida.de ?? '').trim();
        if (!de) continue;

        const tablaPadre = delPadre.get(de);

        if (!tablaPadre) {
          console.warn('[flujo] el formulario padre no tiene la tabla', de);
          continue;
        }

        /*
         * Solo entre tablas que salen de la misma lista.
         *
         * Los campos de una fila se guardan por el identificador del
         * sub-formulario de esa lista; copiándolas a una tabla de otra, lo
         * respondido dentro apuntaría a identificadores que allí no significan
         * nada y la fila se vería vacía. Mejor no copiar y decirlo.
         */
        if (String(tablaPadre.lst ?? '') !== String(tablaHija.lst ?? '')) {
          console.warn(
            '[flujo] las dos tablas no salen de la misma lista: no se copian sus filas',
            de,
            pedida.tabla,
          );

          continue;
        }

        const filas = readRows(respuestas.get(tablaPadre.id)?.val).map((fila) => ({
          ...structuredClone(fila),

          // Es una fila de otra actividad: identificador propio y de la tabla
          // que la recibe.
          GUID: crypto.randomUUID(),
          id: tablaHija.id,
          LinkedAnswerGUID: '',
        }));

        if (!filas.length) continue;

        entradas.push({
          id: tablaHija.id,
          val: filas as unknown as FieldValue,
          fty: 'masterdetail',
          hid: !!tablaHija.hid,
        });
      }

      /*
       * Los archivos: una copia con identificador propio, a partir del
       * original. La hija no comparte el archivo del padre —lo suyo sube bajo
       * su propia actividad— y por eso se copia el contenido en vez de
       * apuntar al mismo GUID.
       */
      for (const pedido of binarios) {
        const campoHijo = delHijo.get(String(pedido.campo ?? '').trim());
        const campoPadre = delPadre.get(String(pedido.de ?? pedido.campo ?? '').trim());

        if (!campoHijo || !campoPadre) {
          console.warn('[flujo] no se puede heredar el archivo: falta el campo', pedido);
          continue;
        }

        const respuesta = respuestas.get(campoPadre.id);
        const archivo = respuesta ? fileValueOf(respuesta) : null;
        if (!archivo?.bin) continue;

        const nuevo = await this.binaryStorage.copiarPara(archivo.bin, hija.GUID, campoHijo.id);
        if (!nuevo) {
          console.warn('[flujo] el archivo del padre no está en este navegador; no se copia', pedido.de);
          continue;
        }

        const copia = { ...archivo, bin: nuevo };
        entradas.push({
          id: campoHijo.id,
          ...splitFileValue(campoHijo.fty, copia),
          fty: campoHijo.fty,
          hid: !!campoHijo.hid,
        });
      }

      if (!entradas.length) return;

      /*
       * Lo heredado se **suma** a lo que la hija ya tenía, por campo.
       *
       * Escribiendo solo las entradas nuevas, «heredar al hijo» sobre una hija
       * ya diligenciada le borraba todo lo demás: quedaba solo lo heredado.
       * Una hija recién creada no tiene nada, así que para ella da igual.
       */
      const nuevas = new Map(entradas.map((e) => [e.id, e]));
      const conservadas = parseAnswerFields(hija.Fields).filter((e) => !nuevas.has(e.id));

      await this.answers.update(hija.ID, { Fields: JSON.stringify([...conservadas, ...entradas]) });
    } catch (error) {
      console.warn('[flujo] no se pudo sembrar la actividad hija', error);
    }
  }

  /**
   * Los campos de un formulario por el nombre con el que los pide una regla.
   *
   * Por `apiId`, y por el identificador interno cuando el campo no trae
   * `apiId`: hay esquemas viejos donde no existe, y una regla escrita sobre
   * ellos nombra el identificador.
   */
  camposPorApiId(survey: Survey | null | undefined): Map<string, FormField> {
    const salida = new Map<string, FormField>();
    if (!survey) return salida;

    for (const page of parseQuestions(survey.JSONQuestion)) {
      for (const field of page.fie) {
        const clave = String(field.apiId ?? '').trim() || field.id;

        if (!clave || salida.has(clave)) continue;

        salida.set(clave, field);
      }
    }

    return salida;
  }

  /**
   * Apunta las consignas que pidió el flujo. **No las manda.**
   *
   * Salen cuando la actividad esté arriba con sus archivos confirmados; de eso
   * se ocupa `DespachoService`, al que se avisa desde el envío. Aquí solo se
   * dejan en la cola local para que sobrevivan a lo que pase en medio: perder
   * la conexión, cerrar la pestaña, apagar el equipo.
   */
  async apuntarLasConsignas(
    engine: FormEngine,
    answer: SurveyAnswer,
    incompleta: boolean,
    elegidos: ReadonlyMap<string, string> = new Map(),
  ): Promise<void> {

    const pedidos = engine.despachosQuePideElFlujo();

    // Con rastro: esto ha costado varias vueltas y desde fuera «no despacha» se
    // ve igual tanto si la regla no se disparó como si se descartó aquí.
    console.debug('[flujo] consignas al guardar', {
      incompleta,
      pedidas: pedidos.length,
      detalle: pedidos,
    });

    for (const despacho of pedidos) {
      /*
       * «Solo si la actividad quedó completa».
       *
       * Guardar deja pasar aunque falten obligatorios —se avisa y quien
       * diligencia decide—, y una consigna que nace de un informe a medias
       * suele ser un error. Con la marca puesta, en ese caso no sale nada.
       */
      if (despacho['soloCompleta'] === true && incompleta) continue;

      /*
       * El que traiga la regla, el que se acaba de elegir en el diálogo, o uno
       * mismo.
       *
       * «Al mismo que la llenó» el motor no lo resuelve —tiene que dar el mismo
       * resultado en el simulador, donde no hay nadie diligenciando— así que lo
       * marca y lo resuelve quien despacha. Aquí sí se sabe quién es.
       */
      const destinatario = (
        String(despacho['destinatario'] ?? '').trim() ||
        elegidos.get(claveDeDespacho(despacho)) ||
        (despacho['mismoUsuario'] === true
          ? String(this.auth.currentUser()?.UserID ?? '')
          : '') ||
        ''
      ).trim();

      /*
       * Sin destinatario no se apunta.
       *
       * No debería llegar aquí: quien guarda ya lo resolvió en el diálogo. Si
       * llega, se avisa en vez de callarse — una consigna que desaparece sin
       * decir nada es lo peor que puede pasar con esto.
       */
      if (!destinatario) {
        console.warn('[despacho] descartado: sin a quién enviarlo', despacho);
        continue;
      }

      await this.despachos.apuntar({
        AnswerGUID: answer.GUID,
        Que: String(despacho['que'] ?? 'otro'),
        SurveyID: String(despacho['formulario'] ?? ''),
        Destinatario: destinatario,
        EstadoGUID: String(despacho['estado'] ?? ''),
        Aviso: String(despacho['aviso'] ?? ''),
        Hija: despacho['hija'] === true,
        Regla: String(despacho['regla'] ?? ''),
        Programado: String(despacho['programado'] ?? ''),
      });
    }
  }

  /**
   * Apunta los correos que pidió el flujo. **No los manda.**
   *
   * Salen cuando la actividad esté arriba con sus archivos confirmados; de eso
   * se ocupa `CorreoService`, al que se avisa desde el envío. Aquí solo se dejan
   * en la cola local para que sobrevivan a lo que pase en medio: perder la
   * conexión, cerrar la pestaña, apagar el equipo.
   *
   * Vienen ya escritos del motor —las variables resueltas y escapadas— así que
   * aquí no hay nada que leer del formulario.
   */
  async apuntarLosCorreos(engine: FormEngine, answer: SurveyAnswer, incompleta: boolean): Promise<void> {

    for (const correo of engine.correosQuePideElFlujo()) {
      /*
       * «Solo si la actividad quedó completa».
       *
       * Lo mismo que en una consigna: guardar deja pasar aunque falten
       * obligatorios, y un correo que cuenta un informe a medias suele ser un
       * error. Con la marca puesta, en ese caso no sale nada.
       */
      if (correo['soloCompleta'] === true && incompleta) continue;

      await this.correos.apuntar({
        AnswerGUID: answer.GUID,
        Llave: String(correo['llave'] ?? ''),
        Para: String(correo['para'] ?? ''),
        Copia: String(correo['copia'] ?? ''),
        CopiaOculta: String(correo['copiaOculta'] ?? ''),

        // Como texto JSON, que es como viaja al servidor. Lo que el motor dejó
        // es **cuál** archivo se quiere, no el archivo: aquí no hay nada que
        // abrir.
        Adjuntos: correo['adjuntos'] ? JSON.stringify(correo['adjuntos']) : '',

        // Los avisos que la regla escribió para la pantalla. Viajan con el
        // correo y no con el botón: valen igual cuando sale al guardar.
        MensajeEnviando: String(correo['mensajeEnviando'] ?? ''),
        MensajeEnviado: String(correo['mensajeEnviado'] ?? ''),
        Asunto: String(correo['asunto'] ?? ''),
        Cuerpo: String(correo['cuerpo'] ?? ''),
        Proveedor: String(correo['proveedor'] ?? ''),
        Area: String(correo['area'] ?? ''),
        Programado: String(correo['programado'] ?? ''),
        Regla: String(correo['regla'] ?? ''),
      });
    }
  }

  /**
   * Apunta las notificaciones que pidió el flujo. **No las manda.**
   *
   * Gemela de `apuntarLosCorreos`, hasta en el motivo: salen cuando la actividad
   * esté arriba, y aquí solo se dejan en la cola local para que sobrevivan a lo
   * que pase en medio —perder la conexión, cerrar la pestaña, apagar el equipo—.
   *
   * Vienen ya escritas del motor: el texto con las variables puestas y la foto
   * convertida en dirección. Aquí no hay nada que leer del formulario.
   */
  async apuntarLosPushes(engine: FormEngine, answer: SurveyAnswer, incompleta: boolean): Promise<void> {

    for (const push of engine.pushesQuePideElFlujo()) {
      // «Solo si la actividad quedó completa», igual que en un correo: guardar
      // deja pasar aunque falten obligatorios, y avisar de un informe a medias
      // suele ser un error.
      if (push['soloCompleta'] === true && incompleta) continue;

      await this.pushes.apuntar({
        AnswerGUID: answer.GUID,
        Llave: String(push['llave'] ?? ''),
        Para: String(push['para'] ?? ''),
        Titulo: String(push['titulo'] ?? ''),
        Texto: String(push['texto'] ?? ''),
        Foto: String(push['foto'] ?? ''),
        Enlace: String(push['enlace'] ?? ''),
        Programado: String(push['programado'] ?? ''),
        Regla: String(push['regla'] ?? ''),
        Disparo: String(push['disparo'] ?? 'guardar'),
      });
    }
  }
}
