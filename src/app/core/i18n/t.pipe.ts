import { Pipe, PipeTransform } from '@angular/core';

import { traducir, type ParametrosTexto } from './idioma.service';
import type { ClaveTexto } from './textos';

/**
 * `{{ 'login.entrar' | t }}` o `{{ 'sync.pendientes' | t: { n: total } }}`.
 *
 * Es impuro a propósito: el resultado depende del idioma, que no es un
 * argumento del pipe. Como `traducir` lee una signal, la plantilla queda
 * suscrita a ella y se vuelve a pintar sola cuando la persona cambia de idioma.
 * El costo es una búsqueda en un objeto por cada pasada, que es nada.
 */
@Pipe({ name: 't', standalone: true, pure: false })
export class TPipe implements PipeTransform {
  transform(clave: ClaveTexto, parametros?: ParametrosTexto): string {
    return traducir(clave, parametros);
  }
}
