import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { activarModoPublicoSiToca } from './app/core/config/modo-publico';
import { loadRuntimeConfig } from './app/core/config/runtime-config';

/**
 * Si la dirección es la de un enlace público, se anota antes de nada.
 *
 * **Antes de arrancar, y antes incluso de la configuración**, porque de esto
 * depende qué base de datos abre la pestaña. La apertura de IndexedDB es
 * perezosa pero no controlada: cualquier servicio que se instancie durante el
 * arranque podría abrirla antes de que un guardia tuviera ocasión de decidir
 * nada, y para entonces ya sería la base equivocada — la de la sesión, con los
 * datos de un enlace público dentro. Aquí no hay ninguna ventana en la que eso
 * pueda pasar.
 *
 * Ver `core/config/modo-publico.ts`.
 */
activarModoPublicoSiToca();

/**
 * La configuración se resuelve antes de levantar la aplicación.
 *
 * Tiene que ser antes: en cuanto el armazón se monta, los servicios empiezan a
 * pedir datos, y si la dirección del backend cambiara a mitad esas primeras
 * peticiones irían al servidor equivocado. Es un `fetch` a un archivo pequeño
 * del mismo origen, y si no está no espera a nada.
 */
loadRuntimeConfig()
  .then(() => bootstrapApplication(App, appConfig))
  .catch((err) => console.error(err));
