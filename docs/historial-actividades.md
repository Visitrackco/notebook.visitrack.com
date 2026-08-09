# Historial de actividades por ubicación o activo

Responder, desde el navegador, la pregunta que se hace en campo: **«¿qué se le
ha hecho antes a este equipo?»**.

## Por qué no se podía antes

El dispositivo solo guarda **mis** actividades. La inspección anterior de ese
equipo probablemente la hizo otra persona, hace ocho meses y con otro
formulario, así que no está aquí y no hay forma de pedirla.

Y las consultas que ya existían en el servidor —las de consignas— parten de un
`SurveyID`: cargan el `JSONQuestions` de **ese** formulario y filtran por él.
Sirven para listar las actividades de un formulario, no para reconstruir la
historia de un activo, que pasa por inspecciones, mantenimientos y reportes de
falla, cada uno con su formulario.

Aquí el formulario es un dato de salida, no un filtro de entrada.

---

## Servicios

`cloud-server`, en archivos propios: `routes/Entities/ActivitiesQuery.js` y
`controllers/Entities/ActivitiesQuery.js`. No se toca nada de lo existente.

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/activitiesByEntity` | El listado, paginado. **No toca `JSONAnswers`** |
| GET | `/activityDetail` | Una actividad, con sus campos ya resueltos |

### Por qué son dos y no uno

`JSONAnswers` es una columna de texto que en un formulario grande pesa cientos
de kilobytes. Traerla en un listado de mil registros son cientos de megas para
enseñar una fecha y un nombre.

Es exactamente el error que tumbaba la aplicación móvil antes de la 0.16.0, y no
tenía sentido repetirlo en el servidor.

### Paginación en la base, no en el cliente

`OFFSET/FETCH` con **veinte** registros por página, y el total en la misma
consulta con `COUNT(*) OVER()`. Un activo con mil actividades devuelve veinte
filas; contar aparte obligaría a repetir los filtros en dos consultas que además
podrían ver cosas distintas.

`dateField` —por qué fecha se filtra y ordena— entra por **lista blanca**
(`CreatedOn`, `DueDate`, `CompletedOn`, `UpdatedOn`): es lo único que va al SQL
como texto, y no puede venir del cliente sin verificar. Todo lo demás son
parámetros.

### Permisos: la zona de trabajo, comprobada una vez

Se ve la historia de una ubicación o un activo **si está en una de las zonas de
trabajo del usuario** (`UsersWorkZones`; un activo hereda la zona de su
ubicación). La comprobación se hace sobre la entidad pedida, **no fila por
fila**: si la sede es mía, su historia es mía, la haya levantado quien la haya
levantado. Eso es justo lo que le da valor a la consulta.

### Dos detalles del esquema que cuestan un rato

- El nombre del formulario es `Surveys.**Title**`, no `Name`.
- El responsable es `AssignedTo`, **salvo que sea 0**, y entonces es
  `CreatedBy`. Una actividad creada en el móvil suele llegar así, y sin ese
  respaldo aparecería sin dueño y como si no fuera tuya.

### `LEFT JOIN` en todo

Las consultas de consignas usan `INNER JOIN` porque una consigna siempre tiene
activo y responsable. En un historial no: una actividad sin activo, sin estado o
sin asignar es normal, y con `INNER JOIN` desaparecería sin que nadie note que
falta.

---

## En el navegador

- **`/historial`** — pantalla propia: se busca la sede o el equipo entre lo que
  está descargado, y se consulta.
- **Pestaña «Historial»** en el detalle de una ubicación o un activo, que es
  donde la pregunta surge sola. Es el mismo componente, con `embedded`.

Es **la única pantalla que exige conexión**, y lo dice antes en vez de aparecer
vacía. Una entidad creada aquí y todavía sin subir no tiene historial que
consultar, y también se dice.

### Se dibuja con el formulario de verdad

`/activityDetail` devuelve **la definición del formulario tal cual** —el mismo
`JSONQuestions` que consume el motor— junto con las respuestas sin cruzar. El
navegador monta un `FormEngine` y pinta cada campo con `vt-field-host`,
exactamente los mismos que se usan al diligenciar.

No es un ahorro de código: es lo que hace que una respuesta se lea **donde y como
se escribió**. Una tabla de etiqueta-y-valor obliga a traducir entre dos
representaciones de lo mismo, y en una inspección de cuarenta preguntas eso es
justo lo que hace que se pase por alto lo que importa.

Se manda entero porque ese componente lo necesita entero: las opciones de un
desplegable, el texto de ayuda, la marca de obligatorio, la lista de la que salen
los ítems. Y así no hay que mantener una segunda forma de pintar cada tipo.

### Ocultos y paginación: los decide el motor, no el servidor

Un primer intento cruzaba preguntas y respuestas **en el servidor** y devolvía
las páginas ya armadas. Estaba mal: enseñaba las páginas marcadas como ocultas y
los campos de secciones que en esa actividad nunca se activaron — el «¿por qué?»
de una opción que nadie eligió.

Qué está oculto depende de lo que se respondió, y de eso sabe el `FormEngine`:
`parseQuestions` descarta las páginas con `hid`, y `visibleFields()` filtra por
las secciones activas. Reusarlo da además la **misma paginación**: mismas
páginas, mismo orden, misma numeración que vio quien la diligenció.

Por eso el servidor manda el esquema **sin filtrar**: recortarlo allí, sin el
contexto de las respuestas, solo podría equivocarse.

### Sin valores por defecto

`FormEngineInput` gana una marca `readOnly`. Cambia una sola cosa, y es la que
importa aquí: no se aplican `def`, ni valores heredados, ni recálculo de los
campos calculados.

Al diligenciar, un `def` es una ayuda que el usuario puede cambiar y que se
acabará guardando. Al consultar una actividad meses después sería **una
respuesta que nadie dio**, indistinguible de las de verdad. Lo que no se
respondió tiene que verse vacío.

**El bloqueo viene del servidor.** Cada campo llega con `rea = true`, que es la
marca de solo lectura que todos los tipos ya respetan —`readonly` en los de
texto, `disabled` en opciones y selectores—. Ponerla en el origen evita depender
de que la interfaz se acuerde de bloquear cada control, uno por uno.

Los campos sin responder llegan con valor vacío en vez de omitirse, y se dibujan
con su etiqueta y su control vacío, en su sitio: que una pregunta quedara sin
contestar es información, y a veces la más importante.

**Los archivos son la única excepción.** El componente del formulario busca su
contenido en la base local, y una actividad que solo se consulta no lo tiene ahí:
está en el bucket. Esos campos se dibujan aparte, con las direcciones del
servidor.

### Al volver, la consulta sigue ahí

Filtros, página, resultado y posición del desplazamiento se guardan en
`ActivityHistoryStateService` antes de entrar a una actividad. Revisar cinco
actividades no puede costar cinco consultas rehechas a mano — y como el listado
es en línea, serían además cinco viajes al servidor.

Se guarda el **resultado** y no solo los filtros, para que volver sea
instantáneo. Vive en memoria y no en la URL a propósito: así no sobrevive a
recargar la página, que es justo cuando no se quiere arrastrar una consulta
vieja. El recuerdo está atado a la entidad, porque restaurar sobre otra sería
peor que no restaurar. Y en la ficha de una ubicación o un activo, volver
reabre la pestaña «Historial» en vez de aterrizar en «Información».

Los archivos no viajan en el detalle. Los valores conservan sus GUID y el
navegador los pide por `/dispatchFile`, que ya existe. Para encontrarlos se
reutiliza `DispatchFilesService.filesOf()`, que ya sabe leerlos aunque el `fty`
venga con otra grafía y entra en las filas de las tablas de detalle.

---

## Descargar una actividad

Baja la actividad y **el contenido de sus archivos** al dispositivo, para
abrirla después sin conexión. Reutiliza `DispatchFilesService.syncOne()`.

### Editable solo si es mía

Una actividad ajena se guarda **a nombre de su dueño**, no del que la baja. No
es un adorno: todas las consultas locales —el listado, los pendientes de subir,
los borradores— van por el índice `byUserID`. Guardarla con el dueño original la
deja invisible para esas consultas y, por lo tanto, **fuera del ciclo de
subida**. Se puede mirar y no se puede pisar, sin añadir ni un estado nuevo al
esquema.

Si es mía entra por la puerta normal, como una actividad ya sincronizada
(`isSaved = 2`, `toSync = 0`). Y si su formulario no está descargado se avisa:
se podrá consultar, pero no abrir a modificar.

### Si ya la tienes, pregunta antes de reemplazarla

Descargar sobre una copia que ya está en el dispositivo la **reemplaza** por la
del servidor. Nunca se hace en silencio.

El aviso tiene dos tonos, y la diferencia importa:

- **La copia local está sincronizada** — se avisa y se sigue. No se pierde nada:
  lo que hay aquí y lo que hay allá son lo mismo.
- **La copia local tiene trabajo sin enviar** (`isSaved` distinto de
  sincronizada, `toSync = 1` o `eraser = 1`) — aviso en rojo diciendo
  exactamente qué se pierde. Eso es trabajo de campo que **no existe en ningún
  otro sitio**, y una vez reemplazado no hay de dónde recuperarlo.

Ante la duda cuenta como que hay trabajo sin enviar: avisar de más molesta, y
perder una hora de campo no se arregla.

---

## Sacar los archivos al computador

En el móvil las fotos son archivos en el disco: se conecta el cable y se copian.
En la web no existen como archivos — son `Blob` dentro de IndexedDB, invisibles
para el explorador de archivos. `BinaryExportService` es la única forma de
llegar a ellos.

- **Carpeta** (`showDirectoryPicker`, solo Chromium): se escribe archivo por
  archivo. Es lo que hay que usar con cientos de fotos, porque no exige tenerlas
  todas en memoria.
- **Comprimido**: un `.zip` que descarga el navegador. Funciona en todos.

El ZIP se escribe **sin comprimir** (método *store*) y sin dependencias nuevas:
son unas cien líneas de cabeceras y un CRC-32. Las fotos, los audios y los
videos ya vienen comprimidos — pasarles *deflate* gasta tiempo y memoria para
ahorrar un uno por ciento. Aquí el `.zip` empaqueta, no aprieta. Por encima de
4 GB se avisa en vez de generar un archivo corrupto: los desplazamientos del
directorio central no caben en cuatro bytes sin ZIP64.

Se organiza en **una carpeta por actividad** —fecha, consecutivo y equipo— con
el campo que originó cada archivo. Un volcado plano de doscientos GUID no le
sirve a nadie: lo que se busca después es «las fotos de la inspección del
martes».

---

## Estado

- ✅ Servidor — escrito, `node --check` y probado con una base simulada: SQL,
  paginación, lista blanca de fechas y los cuatro rechazos de permisos.
- ✅ Navegador — compila y está enganchado en el menú, en las rutas y en el
  detalle de ubicaciones y activos.
- ⏳ **Sin probar contra SQL Server ni contra datos reales.** Antes de darlo por
  bueno hay que correrlo con un usuario que tenga zonas de trabajo y un activo
  con historia de varios formularios.
