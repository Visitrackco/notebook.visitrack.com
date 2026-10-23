import { Asset, LocationForm } from '../models/entities.model';
import { Descriptor, entityDescriptors } from '../../shared/utils/descriptors';

/**
 * Buscar una ubicación o un activo por la etiqueta que lleva pegada.
 *
 * Es lo que hace el móvil al escanear desde «Apps» (`getByTag`): el código que
 * se lee se busca en el `TagUID` de los activos y de las ubicaciones del
 * usuario. Aquí van las reglas puras —qué cuenta como coincidencia y cómo se
 * arma lo que se enseña— para poder probarlas sin base de datos; la consulta a
 * IndexedDB vive en `EtiquetasService`.
 */

/** Una entidad cuya etiqueta coincide con lo escaneado. */
export interface ResultadoDeEtiqueta {
  tipo: 'ubicacion' | 'activo';
  guid: string;
  nombre: string;
  /** El tipo de la entidad («Sede», «Bomba»…), para distinguir dos homónimos. */
  tipoNombre: string;
  /** Una aclaración: la dirección de la sede o la sede del activo. */
  detalle: string;
  /** Sus descriptivos (placa, serie…): distinguen dos equipos con el mismo nombre. */
  descriptivos: Descriptor[];
  /**
   * A dónde lleva: su ficha. `null` cuando no se puede abrir —un activo cuya
   * sede no está en este dispositivo—, porque la ficha de un activo cuelga de
   * la de su ubicación y sin ella no hay qué pintar.
   */
  ruta: string[] | null;
}

/**
 * La etiqueta tal como se compara.
 *
 * Solo se quitan los espacios de los extremos. Un lector de barras —o quien
 * pega el código— arrastra a veces un espacio o un salto de línea al final, y
 * eso no cambia de qué etiqueta se trata. Lo de dentro sí se respeta, igual
 * que las mayúsculas: el móvil compara con `=` en SQLite, y una etiqueta
 * `AB12` y otra `ab12` pueden ser dos equipos distintos.
 */
export function normalizarEtiqueta(valor: unknown): string {
  return (valor ?? '').toString().trim();
}

/** ¿Esta etiqueta es la que se escaneó? Una etiqueta vacía no casa con nada. */
export function etiquetaCoincide(tagUid: unknown, codigo: string): boolean {
  const buscado = normalizarEtiqueta(codigo);
  if (!buscado) return false;

  return normalizarEtiqueta(tagUid) === buscado;
}

/**
 * Arma la lista de resultados.
 *
 * Primero las ubicaciones y luego los activos, cada grupo por nombre: si una
 * misma etiqueta quedó en una sede y en uno de sus equipos, la sede es el sitio
 * natural por donde empezar.
 *
 * @param sedes Las ubicaciones del usuario por GUID, para nombrar la sede de
 *   cada activo y armar su dirección. Basta con las de los activos hallados.
 */
export function armarResultados(
  ubicaciones: readonly LocationForm[],
  activos: readonly Asset[],
  sedes: ReadonlyMap<string, LocationForm>,
): ResultadoDeEtiqueta[] {
  const porNombre = (a: ResultadoDeEtiqueta, b: ResultadoDeEtiqueta) =>
    a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });

  const deUbicaciones = ubicaciones
    .map<ResultadoDeEtiqueta>((ubicacion) => ({
      tipo: 'ubicacion',
      guid: ubicacion.GUID,
      nombre: ubicacion.Name || 'Sin nombre',
      tipoNombre: ubicacion.typeTitle || 'Ubicación',
      detalle: limpiarDetalle(ubicacion.FullAddress) || limpiarDetalle(ubicacion.City),
      descriptivos: entityDescriptors(ubicacion),
      ruta: ['/ubicaciones', ubicacion.GUID],
    }))
    .sort(porNombre);

  const deActivos = activos
    .map<ResultadoDeEtiqueta>((activo) => {
      const sede = sedeDe(activo, sedes);

      return {
        tipo: 'activo',
        guid: activo.GUID,
        nombre: activo.Name || 'Sin nombre',
        tipoNombre: activo.typeTitle || 'Activo',
        detalle: sede ? `En ${sede.Name || 'su ubicación'}` : 'Su ubicación no está en este dispositivo',
        descriptivos: entityDescriptors(activo),
        ruta: sede ? ['/ubicaciones', sede.GUID, 'activo', activo.GUID] : null,
      };
    })
    .sort(porNombre);

  return [...deUbicaciones, ...deActivos];
}

/**
 * La ubicación de un activo, por GUID o por identificador.
 *
 * Por los dos, como en `AssetRepository.findByLocationGuid`: un activo creado
 * aquí bajo una sede también creada aquí lleva `LocationID` en cero y solo se
 * le reconoce por `LocationGUID`; uno descargado puede traer solo el número.
 */
export function sedeDe(
  activo: Pick<Asset, 'LocationID' | 'LocationGUID'>,
  sedes: ReadonlyMap<string, LocationForm>,
): LocationForm | null {
  const guid = String(activo.LocationGUID ?? '');
  if (guid && sedes.has(guid)) return sedes.get(guid)!;

  const id = String(activo.LocationID ?? '');
  if (!id || id === '0') return null;

  for (const sede of sedes.values()) {
    if (String(sede.LocationID) === id) return sede;
  }

  return null;
}

/**
 * Una dirección sin la puntuación suelta.
 *
 * Hay sedes cuya dirección llega armada con las partes vacías —«, »— y
 * enseñarla tal cual ensucia la lista sin decir nada.
 */
function limpiarDetalle(valor: string | null | undefined): string {
  return (valor ?? '').replace(/^[\s,;.-]+|[\s,;.-]+$/g, '');
}
