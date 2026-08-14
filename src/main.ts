import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { loadRuntimeConfig } from './app/core/config/runtime-config';

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
