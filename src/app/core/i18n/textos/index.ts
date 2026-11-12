/**
 * Diccionario de la interfaz: una entrada por clave con el texto en español y
 * en inglés, uno al lado del otro.
 *
 * Va repartido en un archivo por área para que no sea un solo archivo enorme
 * y para que cada pantalla tenga a mano los suyos. Tenerlos en pares —y no en
 * dos diccionarios sueltos— hace imposible que a un idioma le falte una clave:
 * el compilador no deja escribir la entrada a medias.
 *
 * Las claves se nombran `area.que` (`login.entrar`, `sync.titulo`). `comun.*`
 * son los textos que se repiten en toda la aplicación (Guardar, Cancelar…).
 * Los parámetros van entre llaves: `'Caduca en {tiempo}'`.
 */
import { textosActividades } from './actividades';
import { textosArmazon } from './armazon';
import { textosComun } from './comun';
import { textosFormulario } from './formulario';
import { textosLogin } from './login';
import { textosModulos } from './modulos';
import { textosPerfil } from './perfil';

/** Par [español, inglés]. */
export type ParDeTextos = readonly [string, string];

export const TEXTOS = {
  ...textosComun,
  ...textosLogin,
  ...textosArmazon,
  ...textosPerfil,
  ...textosActividades,
  ...textosFormulario,
  ...textosModulos,
} as const satisfies Record<string, ParDeTextos>;

export type ClaveTexto = keyof typeof TEXTOS;
