# Enlaces públicos

Abrir un formulario **sin iniciar sesión**, desde una dirección que se arma en
Module y se reparte por fuera: un correo, un código QR pegado en una máquina, un
enlace en la intranet de un cliente.

Toca los cuatro repos, así que este documento es el mapa entero. Vive aquí
porque la parte difícil —renderizar el formulario completo sin sesión y guardar
en una base separada— es de este repositorio.

---

## 1. Qué resuelve

Hoy, para diligenciar un formulario de Visitrack hay que ser usuario de
Visitrack: entrar, sincronizar y trabajar. Eso deja fuera tres casos que se
piden con frecuencia:

- El **proveedor externo** que entra una vez a llenar un acta y no va a tener
  cuenta.
- El **visitante** que registra su ingreso desde un QR en la portería.
- El **cliente final** que responde una encuesta de satisfacción.

Un enlace público resuelve los tres con la misma pieza: una dirección que ya
lleva decidido qué formulario se abre y a nombre de quién quedan las actividades
que entren por ahí.

---

## 2. Cómo se ve de punta a punta

La sección se llama **Enlaces** y no «Links»: el resto del menú de
Configuración está en español —Ubicaciones, Activos, Listas, Alertas— y una
palabra en inglés en medio se lee como un módulo de otro sitio.

```
Module (CloudGoldFront)          Configuración > Enlaces
   │  crea el enlace: formulario + usuario (+ ubicación / activo)
   ▼
cloud-gold  POST /public-links   ──► dbo.md_public_links   (GUID = randomUUID)
   │
   │  la pantalla enseña   https://web.visitrack.com/#/e/<guid>
   ▼
quien lo recibe abre la dirección en su navegador
   │
   ▼
WebVisitrack  #/e/<guid>
   │  GET  {api}/public/enlace/<guid>               ← resuelve EN LÍNEA
   │  siembra la base `VisitrackPublico` (IndexedDB aparte)
   │  si falta ubicación o activo → los pide EN LÍNEA, paginados
   │  crea la actividad y navega al mismo renderizador de siempre
   ▼
#/formularios/<surveyId>/actividad/<guid>
   │  se diligencia: flujos, todos los FTY, obligatorios, MasterDetail…
   ▼
Guardar
   │  binarios  → POST {api}/public/enlace/<guid>/uploadBinarieServerTwo
   │  actividad → PUT  {api}/public/enlace/<guid>/createdSurveysAnswers
   ▼
#/gracias
```

---

## 3. La decisión que sostiene todo: **cambiar el nombre de la base, no el código**

La consigna era «los mismos comportamientos que en la web con sesión: motor de
flujos, todos los FTY, obligatorios, MasterDetail». La forma barata de cumplirla
sería copiar el renderizador y recortarlo, y esa es justo la forma de que dentro
de tres meses el enlace público se comporte distinto sin que nadie lo note.

Aquí no se copia nada. Lo que se hace es más sencillo y más radical:

> En modo público, la aplicación entera abre **otra** base de IndexedDB
> (`VisitrackPublico` en vez de `VisitrackWeb`) y se siembra en ella, en línea,
> exactamente lo que la sesión habría sincronizado: el usuario, el formulario,
> su flujo, sus listas y las entidades que el enlace fijó.

A partir de ahí **todo el código existente funciona sin tocarlo**:

| Pieza | Por qué sigue funcionando |
|---|---|
| `AuthService.restoreSession()` | Encuentra la fila de `Users` con `Session = '1'` que se sembró |
| `ActivityService.create()` | Ya no lanza «No hay una sesión activa» |
| `BinaryStorageService.save()` | Ídem: tiene `currentUser()` |
| `FlujoService.paraFormulario()` | Lee `Workflows` de la base sembrada |
| `FormRunnerComponent` / `FormEngine` | No sabe de dónde salió el `Survey`; recibe el mismo objeto |
| `ListSourceService` | Las listas se siembran con `IsForSync = 0`, así que consulta en línea por el camino que ya existía |
| Cola de subida, cola de correos, cola de consignas | Escriben y leen en la base pública, aisladas de la de la sesión |

El cambio real en el motor de la base es de tres líneas: `DatabaseService` deja
de leer la constante `DB_NAME` y pregunta por el nombre que toca.

### Por qué el modo se decide antes de arrancar

`main.ts` mira `location.hash` **antes** de `bootstrapApplication` y, si la
dirección es la de un enlace público, lo anota en `sessionStorage`. Dos razones:

- **Antes de arrancar**, porque `DatabaseService.open()` es perezoso pero no
  controlado: cualquier servicio que se instancie durante el arranque podría
  abrir la base antes de que un guard tuviera ocasión de decidir. Decidirlo en
  `main.ts` no deja ninguna ventana.
- **`sessionStorage` y no `localStorage`**, porque es **por pestaña**. Esa es
  toda la garantía de aislamiento que pedía el encargo: la sesión del usuario
  vive en su pestaña con `VisitrackWeb`, el enlace público vive en la suya con
  `VisitrackPublico`, y ni los borradores ni los binarios ni las colas se ven
  entre sí. Con `localStorage` abrir un enlace público habría convertido en
  público también el resto de pestañas.

### A dónde se puede llegar en una pestaña pública

El modo dura lo que dure la pestaña, no lo que dure la dirección —recargar en
mitad del formulario tiene que seguir funcionando, y para entonces la dirección
ya no es la del enlace—. Eso deja una puerta abierta: escribir a mano `#/inicio`
montaría las pantallas de la aplicación con sesión sobre la base pública.

`publicoGuard` la cierra. En modo público solo se abren **la actividad** (con
sus rutas hijas de tablas de detalle) y **`/gracias`**; cualquier otra dirección
devuelve a la puerta del enlace, que sabe qué contar. Queda fuera a propósito
`/formularios/:id` a secas —el listado de actividades del formulario—: existe y
funcionaría, pero es una pantalla de la aplicación con sesión y a ella llevaba
la flecha de volver de la actividad.

### Qué NO se comparte

Nada del almacenamiento por usuario: `appSettings` está dentro de IndexedDB, y
por tanto también es otra copia. Lo único compartido es el tema claro/oscuro, que
vive en `localStorage` y no es un dato de nadie.

---

## 4. La tabla

`dbo.md_public_links` — script idempotente en `cloud-server/sql/md_public_links.sql`.

| Columna | Para qué |
|---|---|
| `ID` | Llave interna. **Nunca sale al exterior**: es secuencial |
| `GUID` | **Es la dirección.** Lo único que viaja en el enlace |
| `CompanyID` | Aísla; todas las consultas públicas filtran por él |
| `Name` | Cómo se llama el enlace en la pantalla |
| `SurveyID` | **Obligatorio.** El formulario que abre |
| `UserID` | **Obligatorio.** A nombre de quién quedan las actividades |
| `LocationID`, `AssetID` | Opcionales. Nulos = «que lo escoja quien diligencie» |
| `IsActive` | Apagarlo es lo primero que se busca si se filtra |
| `ExpiresOn` | Nulo = no caduca |
| `MaxUses`, `Uses`, `LastUsedOn` | Nulo = sin tope. `Uses` sube **al abrir** |
| `BgColor` | Fondo de la página, `#rrggbb`. Nulo = el gris de la aplicación |
| `IsDeleted`, `CreatedBy/On`, `UpdatedBy/On` | Auditoría, como el resto de `md_*` |

### Sin claves ajenas

Las cinco referencias (`SurveyID`, `UserID`, `CompanyID`, `LocationID`,
`AssetID`) van **sin `FOREIGN KEY`**, igual que el módulo de integraciones
(`cloud-gold/sql/integrations-module-sin-fk.sql`) y por la misma razón de fondo:
crear una clave ajena exige un **bloqueo de esquema sobre la tabla
referenciada**, y `Users`, `Companies` y `Surveys` están entre las más ocupadas
de la plataforma — basta con una transacción abierta para que el script se quede
haciendo cola sin crear nada, y quien lo corre no sabe por qué.

Lo que la clave ajena aportaría ya lo hace el servicio, y mejor: en cada alta y
cada edición comprueba que las cinco referencias existan **y sean de la compañía
del enlace**, contra el `CompanyID` que sale del permiso. Una clave ajena solo
mira que la fila exista, no de quién es — que es justo lo que importa en una
tabla que abre una puerta al exterior.

Además evita un efecto real: `Surveys` y `Users` se borran en blando, así que un
borrado físico chocaría con un error de integridad en una tabla que nadie
relacionaría con un enlace público.

Lo que se pierde es la red contra una fila insertada a mano con un identificador
inexistente. Se asume. El script quita las claves ajenas si se corrió una versión
anterior que las creaba.

### El GUID es toda la dirección, y no lleva nada más

```
https://web.visitrack.com/#/e/3f2b0c74-9a1e-4d55-b8c1-6e0f2a7d91ab
```

Ni el formulario, ni la compañía, ni el usuario, ni el `ID`. **Quien recibe el
enlace no puede deducir de la dirección qué hay al otro lado**, de qué empresa
es, ni cuántos enlaces existen. Todo eso se resuelve en el servidor a partir del
GUID, que es la única llave que viaja.

Que no sea el `ID` es la diferencia entre un enlace y un agujero: con
identificadores secuenciales, quien recibe el enlace 41 prueba el 42 y entra en
el formulario de otra compañía.

Lo emite Module con `randomUUID()`, que sale de un generador criptográfico —a
diferencia de `NEWID()`, que la base solo garantiza como único—. El
`DEFAULT NEWID()` de la tabla queda como respaldo para una fila insertada a
mano.

**Un solo identificador público, no dos.** Un borrador de este diseño llevaba
además una columna `Token` aparte. Se descartó: dos identificadores públicos
para la misma fila son dos cosas que mantener sincronizadas y una de más que
puede filtrarse, y el GUID hace ese papel solo. El script deja la tabla igual
venga de donde venga: si se corrió esa versión, quita la columna.

### Por qué el GUID va en claro y los tokens de sesión no

`MOB_UserSessions` guarda el hash de su token porque nadie necesita volver a
leerlo. Aquí es al revés: **la pantalla tiene que enseñar la dirección para
copiarla**, hoy y dentro de seis meses. Con un hash eso sería imposible, y la
alternativa —emitir un identificador nuevo cada vez que alguien quiere copiar el
enlace— invalidaría los enlaces ya repartidos, que es justo lo que un enlace
público no puede hacer.

Lo que compensa esa decisión es el **alcance**: el GUID no abre una sesión, no
sirve para leer nada fuera de lo que ese enlace configuró, y se puede apagar.

### Vencimiento y tope de usos: se implementan, y por omisión no aplican

Se pedía decidirlo. Están **implementados los dos**, y los dos son **nulos por
defecto**.

- Implementados porque son la única forma de que un enlace de un solo uso —«te
  mando esto para la visita del martes»— muera solo. Sin ellos, la única manera
  de cerrarlo sería acordarse de desactivarlo a mano, y así es como se quedan
  abiertos para siempre.
- Nulos por defecto porque el otro caso es igual de real: un QR pegado en una
  máquina se usa a diario durante años, y obligar a poner una fecha convertiría
  el alta en un trámite que además hay que renovar.

`Uses` cuenta **aperturas**, no actividades guardadas. Es lo único que se puede
contar de verdad (quien abre y se va no deja nada) y es lo que sirve de tope
contra el abuso.

Ojo con eso al probar: **depurar consume el tope**. Cada vez que se abre
`#/e/<guid>` cuenta una, así que unas cuantas pruebas se comen un tope de treinta
sin que nadie lo note.

#### Y se puede poner a cero

`POST /public-links/:id/usos`, con un enlace en la ficha de edición junto al
tope, y **sin tocar la dirección**.

Sin esto había una trampa: `Uses` solo sube, así que un enlace que llegaba a su
tope quedaba muerto para siempre. Subir el tope no lo revivía —si llevaba 40
aperturas y el tope pasaba de 10 a 30, seguía agotado— y la única salida era
emitir un GUID nuevo, que invalida la dirección ya repartida. Un límite del que
no se puede volver no es un límite, es una trampa.

Va aparte de guardar y no automático al subir el tope: poner el contador a cero
vuelve a abrir la puerta las veces que diga el tope, y eso lo decide una persona,
no se deduce de que un número haya subido. La ficha enseña siempre cuántas
lleva, para que no haya que adivinar por qué un enlace no abre.

---

## 5. Los endpoints

### 5.1 Públicos — cloud-server, prefijo `/public/enlace/:guid`

`/public/` ya era un prefijo público reconocido por
`cloud-server/src/middlewares/auth.js`; hasta ahora estaba reservado y sin usar.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/public/enlace/:guid` | Resuelve el enlace y devuelve **la semilla** |
| `GET` | `/public/enlace/:guid/ubicaciones?tipo&q&page&size` | Ubicaciones de un tipo |
| `GET` | `/public/enlace/:guid/activos?tipo&loc&q&page&size` | Activos de un tipo, o de una sede |

Y la **lista blanca de reflejos**: las mismas rutas que la web ya usa, colgadas
del prefijo y con la identidad forzada desde el enlace.

| Reflejo | Original |
|---|---|
| `PUT …/createdSurveysAnswers` | la subida de la actividad |
| `POST …/uploadBinarieServerTwo` | la subida de un archivo |
| `POST …/verifyBinariesInBucket` | ¿ya están las fotos en el bucket? |
| `GET …/verifyAnswerExists` | ¿quedó creada de verdad? |
| `PUT …/searchList` | los desplegables que se consultan en línea |
| `PUT …/encolarCorreoDeFlujo` | la cola de correos del flujo |
| `PUT …/despacharDeFlujo` | la cola de consignas del flujo |
| `GET …/getCompanyLogo` | el logo de la compañía |

### Por qué reflejos y no «el mismo endpoint sin guard»

Tres razones, en orden de importancia:

1. **La identidad no la escribe el cliente.** En `/createdSurveysAnswers` el
   `CompanyID`, el `UserID` y el `SurveyID` llegan en el cuerpo. En el reflejo
   se **sobrescriben** con los del enlace antes de llamar al controlador. Sin
   eso, cualquiera con un enlace podría crear actividades de otro formulario y a
   nombre de otra persona: bastaría con cambiar tres números del cuerpo.
2. **`AUTH_STRICT`.** Hoy el servidor está en modo gracia y una petición sin
   token pasa. El día que se apriete —está previsto— el flujo público dejaría de
   funcionar sin previo aviso. Bajo `/public/` no depende de eso.
3. **La lista blanca es el contrato.** Lo que un enlace puede llamar está
   escrito en un solo archivo y se lee de un vistazo.

Del lado del cliente esto sale gratis: en modo público la URL base pasa a ser
`{apiUrl}/public/enlace/{guid}` y **todas** las llamadas quedan dentro del
prefijo sin tocar una a una. Es una comodidad, no un control de seguridad —
quien tenga el GUID puede escribir peticiones a mano igual—; el control está en
el servidor.

### La excepción: `/integrations/ejecutar` va por cabecera

Llamar a un servicio externo desde una regla de flujo **no** lleva prefijo. Se
pide a la ruta de siempre y el enlace se identifica con una cabecera:

```
POST /integrations/ejecutar
x-enlace: d245aec4-f395-43ba-8925-4a1983cb6037
```

**Por qué se descartó el prefijo aquí.** Una credencial va en una cabecera, como
`x-token`, y no dentro de la ruta. Metido en la URL, el identificador del enlace
ensucia la dirección, se cuela en el registro del servidor y en el de cualquier
proxy por el que pase, y obliga al cliente a armar rutas distintas según cómo se
abrió el formulario.

**Quién la deja pasar.** `middlewares/auth.js`: si no hay sesión válida y la
ruta está en `RUTAS_DE_ENLACE` —hoy solo esa—, resuelve el enlace con
`providers/auth/enlaces.js` y planta su identidad en `req.auth`. El enlace **no**
abre las demás rutas; se comprobó.

**Por qué no bastaba con quitar el prefijo y ya.** `ejecutar` exige `req.auth` a
propósito: sin saber quién pregunta no puede acotar la integración a su
compañía, que es todo el aislamiento. Una llamada sin prefijo y sin cabecera
habría respondido 401, no 404. La cabecera es lo que aporta esa identidad — y
sale de la fila del enlace, no de quien llama, así que es una prueba más fuerte
que un token de sesión.

Mismas condiciones que para abrir: el enlace tiene que estar vivo, sin vencer y
sin agotar. No incrementa `Uses`: eso cuenta aperturas, y esto no lo es.

### 5.2 Autenticados — cloud-gold, `/public-links`

CRUD completo, permiso `CONFIG_PUBLIC_LINKS` comprobado **dentro del servicio**,
que es el patrón de los módulos nuevos (workflows, integrations, emails).

| Método | Ruta |
|---|---|
| `GET` | `/public-links?page&size&q` |
| `GET` | `/public-links/opciones` — formularios y usuarios de la compañía |
| `GET` | `/public-links/ubicaciones?surveyId&q` |
| `GET` | `/public-links/activos?locationId&q` |
| `POST` | `/public-links` — crea o actualiza según venga `id` |
| `POST` | `/public-links/:id/active` |
| `POST` | `/public-links/:id/direccion` — emite un GUID nuevo |
| `POST` | `/public-links/:id/usos` — pone el contador de aperturas a cero |
| `DELETE` | `/public-links/:id` — borrado lógico |

Emitir un GUID nuevo es una acción aparte y con aviso: **invalida la dirección
ya repartida**. Es lo que se hace cuando un enlace se filtró pero se quiere
seguir usando la misma configuración.

---

## 6. La semilla

`GET /public/enlace/:guid` devuelve las filas **con la misma forma que el
stream de sincronización** (`getSyncNew`), agrupadas por código de entidad:

```jsonc
{
  "status": true,
  "response": {
    "enlace":  { "nombre": "...", "surveyId": 123, "conUbicacion": true, "conActivo": false },
    "usuario": { "ID": 771295, "CompanyID": 3502, "FirstName": "...", ... },
    "entidades": {
      "79":  [ /* Surveys      */ ],
      "100": [ /* md_workflows */ ],
      "2":   [ /* LocationsTypes */ ],
      "10":  [ /* AssetsTypes  */ ],
      "0":   [ /* DispatchStatus */ ],
      "7":   [ /* Lists        */ ],
      "1":   [ /* Locations, solo la quemada si la hay */ ],
      "12":  [ /* Assets, íd.  */ ]
    }
  }
}
```

El cliente las escribe con `ENTITY_MAPPERS` — **los mismos mapeadores que usa la
sincronización**. Así no hay una segunda traducción que mantener, y lo que se
guarda en la base pública es byte a byte lo que la sesión habría guardado.

### Las listas bajan sin sus ítems

`Lists` se siembra con `IsForSync = 0`. Esa bandera ya significa «esta lista no
está descargada», y `ListSourceService` ya sabe qué hacer con ella: consultarla
en línea por `/searchList` según se escribe. Es exactamente lo que hace falta
aquí —no hay sincronización previa— y no cuesta ni una línea de código nuevo.

---

## 7. Elegir ubicación y activo en línea

Cuando el enlace no las quemó y el formulario las pide, la pantalla del enlace
las ofrece **antes** de crear la actividad, consultando en línea con paginación
de 25 y buscador (300 ms de espera entre teclas).

El servidor acota lo que puede salir por ahí:

- Las ubicaciones, al **tipo de ubicación que declara el formulario**
  (`Surveys.LocationTypeID`) y a la compañía del enlace.
- Los activos, al **tipo que declara el formulario** y a la ubicación ya
  elegida.
- Nunca se devuelve el catálogo entero de la compañía, y nunca sin filtro de
  tipo: un enlace a un formulario de porterías no puede listar la flota.

Lo elegido se escribe en la base pública con los mismos mapeadores, así que
`attachLocation` / `attachAsset` y la comprobación de coherencia
(`checkConsistency`) funcionan igual que con sesión.

### Y los desplegables que salen de ubicaciones o activos

Distinto de lo anterior. Un **campo** cuyo origen es una entidad (`ent = 1` o
`12`) trae en `lst` **su propio** tipo, que no tiene por qué ser el del
formulario: un acta de mantenimiento pide la sede en la cabecera y, dentro, un
desplegable con los extintores de esa sede.

Esos desplegables leen del catálogo local, y en una pestaña pública el catálogo
solo tiene lo que el enlace sembró. Salían vacíos con el mensaje «descárgalas
desde Sincronización» —que a quien abre un enlace no le dice nada y no puede
hacer— y el formulario se quedaba **sin poder terminarse, sin ningún error a la
vista**. Era el hueco que más podía doler.

En modo público consultan en línea, por los mismos endpoints con un parámetro
`tipo` (`ListSourceService.deLaRedPorTipo`).

**Qué tipos se admiten.** Solo los que **ese formulario menciona**: el suyo
propio, o uno que aparezca en su `JSONQuestions`. Aceptar cualquiera convertiría
el enlace en una ventana al catálogo entero de la compañía. Se acepta por GUID o
por identificador, porque el formulario guarda unas veces uno y otras el otro.

**Y rechazar es rechazar.** Un tipo no admitido devuelve vacío, no «sin filtro».
La primera versión dejaba la variable en nulo, el filtro por tipo se saltaba
entero y la consulta respondía con **todos los activos de la compañía** — mucho
peor que dejar ver uno de más. Lo encontró la prueba, no la lectura.

**La sede es opcional para un desplegable.** Son dos usos del mismo endpoint: al
abrir la actividad se elige el equipo que está *en* la sede ya elegida, y sin
sede la pregunta no tiene sentido; pero un desplegable ofrece los del tipo y no
los de una sede —como hace la app—, y ahí exigirla lo dejaría siempre vacío.

Una sola página de 25 con el buscador del servidor. En un catálogo grande eso
significa escribir para encontrar lo tuyo, que es como se usa un desplegable
largo.

---

## 8. Cómo se ve: el fondo y la marca

El enlace decide **el papel de la página**, y nada más.

### Solo tonos claros, y por qué

Todo lo que va encima del fondo —las tarjetas de cada pregunta, los campos, los
bordes, el banner— sigue con los tonos del tema, calculados para superficies
claras. Un fondo oscuro deja tarjetas blancas flotando sobre negro y campos que
no se leen.

Se podría garantizar el contraste recalculando el tema entero a partir del color
elegido, y eso es otra cosa distinta de lo que se pidió: se pidió elegir el
papel, no rehacer la aplicación. Así que se admite lo que se puede sostener y se
rechaza lo demás.

**El corte: luminancia relativa (WCAG) ≥ 0.55.** Medido, no elegido a ojo:

```
Blanco #ffffff 1.000   Arena #f5f1e8 0.881   Menta #eaf4ee 0.884
Cielo  #eaf1f8 0.872   Lavanda #f0edf7 0.858  Gris claro #d0d0d0 0.631  → pasan
Azul medio #4a90d9 0.264   Rojo marca #d32029 0.150   Carbón #1c1f26 0.014 → no
```

Se aplica en **tres capas**, para que no dependa de una sola: la pantalla de
Module avisa antes de guardar, `cloud-gold` rechaza con un mensaje, y
`cloud-server` ignora un color oscuro de una fila antigua y manda el gris.

> **El 0.55 está repetido en los tres repos y no hay dónde compartirlo.**
> Vive en `cloud-server/src/controllers/Public/EnlacesPublicos.js`
> (`colorValido`), en `cloud-gold/.../public-links.service.ts`
> (`FONDO_LUMINANCIA_MINIMA`) y en
> `WebVisitrack/src/app/core/services/theme.service.ts` (mismo nombre). Son
> codebases separadas sin biblioteca común. Si algún día se cambia, hay que
> cambiarlo en los tres — o uno aceptará un color que otro no sabe pintar.

### Un error que costó caro: no se toca `--vt-text`

Una versión anterior forzaba el color del texto para «garantizar el contraste»
con el fondo elegido. Fue un error con consecuencias visibles: `--vt-text` no es
el texto de la página, es el de **todo** —incluido el que va dentro de las
tarjetas blancas de cada pregunta—, así que ponerlo en blanco por un fondo
oscuro dejaba los campos ilegibles. `applyFondo` escribe **solo** `--vt-bg`.

### Dónde se elige

- **Del enlace**: paleta de siete tonos claros más un selector libre, en la
  ficha de Module. Es del enlace, no de quien lo abre.
- **De la aplicación con sesión**: el mismo mecanismo, en Perfil, junto al color
  de marca que ya existía. Extiende `ThemeService` con la forma de `brandColor`.

### El color sobrevive a un F5

El enlace solo se resuelve en `#/e/<guid>`, y recargar la actividad no vuelve a
pasar por ahí. Se apunta en `sessionStorage` —**por pestaña**, como el GUID— y
`ThemeService.readFondo()` lo lee al construirse, antes del primer fotograma, de
modo que no hay fogonazo gris al refrescar. En `localStorage` se le habría
colado a la sesión abierta en otra pestaña.

### La marca

Un banner lateral con el **logo de la compañía dueña del enlace** arriba y la
atribución de Visitrack al pie. Sin menú, sin contadores, sin enlaces: quien
abre esto no viene a navegar, viene a responder una cosa.

Va claro y no con el panel oscuro de la aplicación: los logos de cliente vienen
casi siempre en trazo oscuro sobre transparente y sobre el panel oscuro
desaparecen, y una franja oscura fija se pelearía con el fondo que traiga el
enlace. En pantallas de menos de 900 px el banner se acuesta como franja
superior.

El nombre de la compañía viaja en la semilla (`Companies.Name`, en consulta
propia: si falla, el formulario abre igual) y se recuerda por pestaña como el
fondo. Sin nombre el respaldo es «Visitrack» y **no** «Compañía 3502»: ese número
es una llave interna que además deja ver cuántas compañías hay y en qué orden se
dieron de alta.

---

## 9. Qué pasa con la actividad después de guardarse

Esta era la pregunta con más riesgo de quedar en un limbo. La respuesta corta:
**sube sola, por el mismo camino de siempre, y quien diligenció lo ve en
pantalla.**

En detalle:

1. Al pulsar Guardar, `FormRunnerComponent.commit()` hace lo de siempre: resuelve
   el flujo, apunta correos y consignas, marca la actividad y llama a
   `PendingUploadService.run(guid)`.
2. Esa cola sube **primero los binarios** (`uploadBinarieServerTwo`), espera a
   que el servidor confirme que están en el bucket (`verifyBinariesInBucket`) y
   solo entonces crea la actividad (`createdSurveysAnswers`). Es la regla que ya
   existía y que evita que una actividad llegue a Visitrack apuntando a fotos
   que todavía no existen.
3. Cuando la actividad está creada y confirmada, se encolan los correos y las
   consignas que pidió el flujo.
4. La pantalla `#/gracias` **no miente**: enseña el estado real de la subida
   —«enviando», «enviado», «esperando tus fotos», «no se pudo»— y ofrece
   reintentar. Mientras algo quede pendiente, dice que no se cierre la pestaña.

**Quién la sube:** el propio navegador de quien diligenció, en su pestaña. No
hay proceso de servidor que rescate una actividad pública abandonada.

**Qué pasa si cierra antes de tiempo:** la actividad queda en `VisitrackPublico`
con su estado. Si vuelve a abrir **el mismo enlace en el mismo navegador**, la
pantalla del enlace lo detecta y le ofrece reintentar la subida antes de empezar
una nueva. Si no vuelve, se pierde — y eso está asumido: no hay sesión con la que
identificar a esa persona más tarde, ni forma de avisarle.

Por eso la subida empieza **inmediatamente** al guardar y no se difiere, y por
eso la pantalla de gracias insiste mientras haya algo en vuelo. Es la única
ventana que hay.

**Limpieza:** al abrir un enlace público se borra de `VisitrackPublico` todo lo
que ya subió y tenga más de siete días. Lo que no ha subido no se toca nunca.

---

## 10. Seguridad

### Lo que el GUID concede

Un formulario, un usuario, una compañía. Nada más. Cada endpoint público
resuelve el enlace primero y **deriva de él** la compañía, el usuario y el
formulario; lo que venga en el cuerpo o en la consulta se descarta o se
sobrescribe.

### Lo que no concede

- No es una sesión: no vale como `x-token` en ningún otro endpoint.
- No permite deducir otros enlaces ni saber qué abre: el `ID` secuencial no sale
  nunca al exterior, la dirección no lleva formulario ni compañía, y el GUID lo
  emite `randomUUID()`.
- No permite leer actividades ya guardadas, ni el histórico, ni el catálogo de
  la compañía.

### Contra el abuso

Un enlace público se puede pegar en cualquier parte. Lo que hay:

| Defensa | Estado |
|---|---|
| Desactivarlo (`IsActive = 0`) | **Implementado.** Efecto inmediato |
| Vencimiento (`ExpiresOn`) | **Implementado.** Opcional |
| Tope de usos (`MaxUses`) | **Implementado.** Opcional |
| Emitir un GUID nuevo | **Implementado.** Invalida la dirección repartida |
| Límite de peticiones por IP y por enlace | **Implementado**, en memoria: 30 peticiones por minuto y por IP, 300 por minuto y por enlace |
| Comprobación de humanidad (captcha) | **No implementado.** Ver abajo |
| Límite compartido entre instancias | **No implementado.** Ver abajo |

**El límite es por proceso.** `cloud-server` corre en una sola instancia hoy, así
que en la práctica es el límite real; el día que se ponga detrás de un
balanceador con varias instancias, cada una contará por su cuenta y el tope
efectivo se multiplicará por el número de instancias. Llevarlo a una tabla o a
Redis es el paso siguiente, y no se hizo ahora porque añade una dependencia por
un riesgo que hoy no existe.

**No hay captcha.** Alguien decidido puede llenar el formulario mil veces desde
mil direcciones. Contra eso el tope de usos es la respuesta útil —y está—; un
captcha es la respuesta completa, y conviene ponerlo antes de usar enlaces
públicos de cara a internet abierta. Queda anotado como lo primero que hay que
añadir si esto se usa fuera de un entorno controlado.

### Y contra tumbar el servidor

El límite por IP se aplica **antes** de mirar siquiera la forma del GUID, para
que un bucle probando direcciones inventadas también cuente. Y la resolución del
enlace atiende el caso de que la base no responda: `connection()` no lanza en
ese caso —registra y devuelve `undefined`—, y sin tratarlo el `TypeError`
resultante quedaba sin recoger, la petición se colgaba y en Node 22 el proceso
se caía entero. Ahora responde 503. Se descubrió ejecutándolo, no leyéndolo.

### Lo que se registra

Cada apertura deja `Uses` y `LastUsedOn`. No se guarda la IP de quien abre: es
un dato personal que nadie ha pedido y que no responde ninguna pregunta que las
dos columnas anteriores no respondan.

---

## 11. Archivos

### cloud-server (subir a mano)

```
src/controllers/Public/EnlacesPublicos.js   NUEVO
src/routes/Public/EnlacesPublicos.js        NUEVO
src/providers/auth/enlaces.js               NUEVO   (identidad por enlace)
src/middlewares/auth.js                     MODIFICADO (cabecera x-enlace)
src/routes/index.js                         una línea
sql/md_public_links.sql                     NUEVO (correr a mano)
```

Se despliega **a mano**: ese repo no tiene git. Y hay que **reiniciar Node**
después — Express registra rutas y middlewares al arrancar, así que copiar los
archivos encima no basta.

### cloud-gold

```
src/presentation/public-links/public-links.controller.ts   NUEVO
src/presentation/public-links/public-links.module.ts       NUEVO
src/presentation/public-links/public-links.service.ts      NUEVO
src/app.module.ts                                          dos líneas
```

### CloudGoldFront

```
.../configuracion/components/list-public-links/*           NUEVO (3 archivos)
.../configuracion/configuracion-menu.ts                    sección «Enlaces»
.../configuracion/configuracion.component.ts               módulo + permiso
.../configuracion/configuracion.component.html             una rama
src/app/app.routes.ts                                      dos rutas
```

### WebVisitrack

```
src/app/core/config/modo-publico.ts                        NUEVO
src/app/core/config/api-base.ts                            NUEVO
src/app/core/guards/publico.guard.ts                       NUEVO
src/app/core/services/enlace-publico.service.ts            NUEVO
src/app/features/publico/enlace-publico.component.{ts,html,scss}   NUEVO
src/app/features/publico/gracias.component.{ts,html,scss}          NUEVO
src/app/features/publico/publico-shell.component.ts                NUEVO
src/main.ts                                                activar el modo
src/app/core/database/schema.ts                            nombre de la base pública
src/app/core/database/database.service.ts                  usar el nombre que toca
src/app/app.routes.ts                                      rutas y armazón público
src/app/features/activities/activity-detail.component.ts   la salida en modo público
src/app/core/services/api.service.ts                       ┐
src/app/core/sync/upload-api.service.ts                    │ los cuatro que
src/app/core/forms/list-search.api.ts                      │ calculaban la
src/app/core/forms/integraciones.api.ts                    ┘ URL base
src/app/core/services/theme.service.ts                     el fondo de la página
src/app/features/profile/profile.component.{ts,html}       elegirlo con sesión
src/app/core/forms/list-source.service.ts                  desplegables en línea
src/app/core/services/session-end.service.ts               un 401 no cierra nada
src/app/core/services/binary-storage.service.ts            subida en línea
```

`dispatch-files.service.ts` **no** se tocó, y es a propósito: `/dispatchFile` ya
era público en `cloud-server` —lo consume un `<img src>`, que no puede mandar
cabeceras— así que funciona igual desde una pestaña pública sin necesidad de un
reflejo.

---

## 12. Lo que no se tocó

**El motor de flujos.** Nada de lo de este documento necesitó tocarlo: el motor
recibe un flujo y un contexto, y le da igual de dónde salieron.

> Ojo con no leer de más aquí. Los tres motores **sí** cambiaron en paralelo,
> por otro trabajo: se les añadió `Resultado.evaluadas` y se pasó a archivar por
> regla lo que antes iba por `momento:campo`. Eso no es parte de los enlaces
> públicos y está documentado en
> `CloudGoldFront/docs/flujos-de-trabajo.md`. Lo único que este trabajo tocó de
> esa zona es `form-engine.ts` —la capa de orquestación propia de WebVisitrack,
> que no tiene gemelo— con `olvidarLlamadasQueYaNoSePiden`.

**La app móvil.** Un enlace público no tiene sentido en una aplicación que exige
iniciar sesión para instalarse.

---

## 13. Lo que **no** se ha comprobado

Esto es lo primero que hay que leer antes de dar nada por bueno.

### Nada de esto se ha visto con la aplicación delante

Todo lo de este documento está verificado por **compilación, prueba
automatizada o lectura del código**. En ningún momento se abrió un enlace en un
navegador con datos reales.

Concretamente, no se ha visto funcionando: crear un enlace en Module, abrirlo,
que el fondo elegido se pinte, que el logo de la compañía salga en el banner,
que los desplegables de ubicaciones y activos traigan opciones, que una foto
suba al capturarla, que la actividad llegue a Visitrack, ni que la pantalla de
cierre acabe diciendo que ya está.

Las pruebas que sí se corrieron —contra el middleware real, contra el router
real y contra una base simulada— cubren la lógica, no el resultado en pantalla.

### El orden para probarlo

1. Correr `sql/md_public_links.sql` (idempotente; incluye `BgColor`).
2. Subir los archivos de `cloud-server` y **reiniciar Node**.
3. Crear un enlace con color y abrirlo.

El atajo para no depender del despliegue: levantar `cloud-server` en local
(`npm start`, puerto 100) y poner `useLocalApi: true` en
`WebVisitrack/src/environments/environment.ts`. Ese servidor ya tiene todo.

Para que Module genere la dirección apuntando al dev server, en el `.env` de
`cloud-gold`:

```
PUBLIC_LINK_BASE_URL=http://localhost:4200/#/e
```

### Huecos conocidos

- **Sin captcha.** Contra el uso masivo desde muchas IP el tope de aperturas es
  la respuesta útil, y está; un captcha es la completa. Antes de usar enlaces
  públicos de cara a internet abierta, es lo primero que hay que añadir.
- **El límite de peticiones es por proceso.** Real hoy —una sola instancia—;
  detrás de un balanceador cada una contaría por su cuenta.
- **`campos`, `bloqueos`, bloqueo de edición, `descriptivos` y `encargos`**
  siguen archivados por `momento:campo` en el motor y tienen el mismo fallo
  latente que tuvieron los avisos y las llamadas. No se tocó porque ahí la
  combinación no es una concatenación y nadie ha reportado el síntoma.
- **Escribir a mano encima del valor que trajo una integración**, con la
  condición todavía activa, sigue sin protegerse: otra evaluación puede volver a
  escribir el campo. Solo se arregló el ciclo desactivar-reactivar.
