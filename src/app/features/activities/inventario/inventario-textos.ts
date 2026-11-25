import { traducir } from '../../../core/i18n/idioma.service';
import { PerfilInventario } from '../../../core/inventario/perfil-inventario';

/**
 * Lo que dice el perfil de inventario de un formulario, en palabras. Gemelo de
 * `_Textos` de `AvisoDeInventario.dart` del móvil.
 */
export function textoDelTipo(p: PerfilInventario): string {
  if (p.tipo.modo === 'campo') return traducir('inv.tipoSegunCampo');
  if (p.tipo.modo === 'estado') return traducir('inv.tipoSegunEstado');
  switch (p.tipo.valor) {
    case 'ENTRADA':
      return traducir('inv.tipoEntrada');
    case 'SALIDA':
      return traducir('inv.tipoSalida');
    case 'AJUSTE':
      return traducir('inv.tipoAjuste');
    case 'TRASLADO':
      return traducir('inv.tipoTraslado');
  }
  return traducir('inv.tipoMovimiento');
}

export function textoDeCuando(p: PerfilInventario): string {
  if (p.cuando.modo === 'guardar') return traducir('inv.cuandoGuardar');
  if (p.cuando.modo === 'estados') return traducir('inv.cuandoEstados');
  return traducir('inv.cuandoCompletar');
}

export function textoDelNegativo(p: PerfilInventario): string {
  if (p.negativo === 'bloquear') return traducir('inv.negativoBloquea');
  if (p.negativo === 'permitir') return traducir('inv.negativoPermite');
  return traducir('inv.negativoAvisa');
}

export function textoDeRepetir(p: PerfilInventario): string {
  return traducir(p.repetir === 'ajustar' ? 'inv.repetirAjusta' : 'inv.repetirUnaVez');
}
