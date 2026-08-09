# MasterDetail como tabla: pegar desde Excel

> **Estado: propuesta, sin implementar.** Documento de diseño para cuando se
> retome. Acordado en agosto de 2026.

En el teléfono un MasterDetail es una pila de filas que se abren de una en una,
porque en una pantalla de cinco pulgadas no hay otra opción. En un monitor esa
misma inspección de treinta equipos es una **tabla**: columnas los campos, filas
los equipos, edición en el sitio y Tab para avanzar.

Encima de eso, **pegar un bloque desde Excel**. Mucha gente ya lleva sus lecturas
en una hoja de cálculo; que pegar cree las filas convierte quince minutos de
digitación en un `Ctrl+V`.

La lógica de orígenes ya está resuelta en `core/forms/master-detail-source.service.ts`
—de dónde salen las filas según la configuración de la lista— y no se toca. Lo
nuevo es la vista de tabla y **la resolución de nombres a GUID**, que es donde
está toda la dificultad real.

---

## El problema: un nombre no es una referencia

Una fila de MasterDetail enlazada a una lista no guarda un texto, guarda un
**registro**. Lo que se pega desde Excel es texto. Entre una cosa y la otra hay
que resolver, y resolver mal no falla: **sube**. La actividad queda enlazada a un
activo que nadie escogió y no se nota hasta que alguien audita.

De ahí la única regla que gobierna toda esta función:

> **Nunca adivinar.** Un pegado que se detiene a preguntar es barato. Uno que
> resuelve solo y se equivoca, no.

## La resolución ocurre dentro del origen, no en el catálogo

La búsqueda en línea (`core/forms/list-search.api.ts` → `PUT /searchList`) es
**contextual**: lleva `parent`, `loc`, `ass` y `parentlist`. Eso no es un detalle
de implementación, es parte de la definición de qué es una opción válida.

Resolver un nombre por lo tanto no es «buscarlo en el catálogo», es **buscarlo
dentro del mismo origen y con el mismo contexto que el selector le habría
ofrecido a esa fila**. Si se salta el contexto se puede enlazar un registro que
el usuario jamás habría podido elegir a mano.

## Los tres resultados

Cada celda de referencia cae en uno, y la fila hereda el peor de los suyos:

| Resultado | Qué se hace |
|---|---|
| **Un solo registro** | Se enlaza el GUID. Sin preguntar |
| **Varios** | Ambigüedad: decide el usuario |
| **Ninguno** | No se inventa la fila |

## La ambigüedad se pregunta una vez por nombre, no por fila

Esto es lo que decide si la función se siente ágil o insoportable. Si «Bomba 3»
aparece ocho veces en lo pegado, se pregunta **una vez** y la decisión se aplica
a las ocho. Treinta filas rara vez tienen treinta nombres distintos.

Para decidir se muestran los **descriptivos** —placa, serie, sede—, que es
exactamente lo que se resolvió en la versión 0.15.2 del móvil para los
desplegables: `jsonDescriptors` del tipo, no un «Valores» que no distingue dos
equipos que se llaman parecido.

## El mejor arreglo es no depender del nombre

Casi toda hoja de cálculo de campo trae la placa o el código al lado del nombre.
Si al pegar se pueden **mapear columnas** —«esta es el nombre, esta es la
placa»—, la placa desambigua sola y la mayoría de los conflictos desaparecen
antes de existir.

Mejor todavía: si hay columna de código, se resuelve **por código** y el nombre
queda solo como verificación — «pegaste *Bomba 3* pero ese código es *Bomba 03*,
¿sigo?».

Conviene empujar esto en la interfaz, porque convierte el caso difícil en el
caso raro.

## Tres caminos según de dónde salen los ítems

- **Lista descargada** (`IsForSync = 1`): se resuelve contra IndexedDB.
  Instantáneo y sin límite de filas.
- **Lista en línea** (`IsForSync = 0`): hay que preguntarle a `/searchList`.
  Primero se **deduplican los nombres** —treinta filas suelen ser doce nombres—
  y esos van en una tanda con concurrencia limitada.
  Si la función se toma en serio, en `cloud-server` cabe un `POST /searchListBatch`
  que reciba el arreglo de nombres y devuelva los candidatos de cada uno: una
  petición en vez de doce. Es media tarde de backend y quita el único punto lento.
- **Lista en línea sin conexión**: no se puede resolver, y no se importa a
  medias. Sirve el mensaje que ya existe: «esta lista se consulta en línea;
  descárgala desde Sincronización para usarla sin red».

## Normalizar para comparar, nunca para guardar

Al comparar: recortar espacios, colapsar los dobles, ignorar mayúsculas y
tildes. Lo que se guarda es siempre el registro real, jamás el texto
normalizado.

Con un matiz que importa: si dos registros distintos solo se diferencian por una
tilde, eso **no es un acierto, es una ambigüedad**. Normalizar de más es otra
forma de adivinar.

## La pantalla de conciliación

El pegado no escribe nada. Abre una tabla de revisión:

```
24 filas · 20 listas · 3 por decidir · 1 sin encontrar
                                    [ Ver solo las que faltan ]
```

- Cada fila con su estado.
- Las ambiguas, con un desplegable ya cargado de candidatos y sus descriptivos.
- Las no encontradas, con la opción de **crear** solo si la lista lo permite. Y
  ahí aplica el default asimétrico que la app ya respeta: `mobAdd ?? false` —
  agregar está cerrado por omisión, así que casi siempre esa opción ni aparece.

**Se confirma entero o no se confirma nada.** Una importación a medias deja al
usuario sin saber qué entró y qué no, y en un MasterDetail eso es peor que
repetir el pegado.

## Un efecto secundario que se agradece

La pantalla saca a la luz problemas de calidad de datos que hoy nadie ve. «Hay
tres activos llamados *Bomba 3* en esta sede» es un hallazgo que vale por sí
solo, y hoy no hay ningún sitio donde aparezca.
