# Notificaciones push

Cómo sale un aviso, cómo se sabe si llegó, y por qué está montado así.

Toca cuatro repos: `cloud-server` (envía), `cloud-gold` (administra),
`CloudGoldFront` (las pantallas de Module) y `WebVisitrack` + `vtmobileplusnew`
(reciben).

---

## 1. La idea en una línea

**Todo push pasa por una cola, y la cola es la bandeja.** No hay un camino
rápido que se salte el registro.

```
alguien pide un aviso
        │
        ▼
  VTServicesPushOutbox        ← una fila por (aviso, persona)
        │
   flujo_push.js (cada minuto)
        │
        ▼
     FCM v1  ──►  todos los aparatos de esa persona
                        │
                        ├─ se enseñó  ─► POST /public/push/acuse  {entregado}
                        └─ lo tocaron ─► POST /public/push/acuse  {abierto}
```

## 2. Por qué una cola y no un envío directo

Antes había **siete sitios** mandando push por su cuenta: cada uno buscaba el
token en `UsersDeviceToken` y llamaba a FCM. Eso tenía tres problemas, y ninguno
era evidente desde fuera:

1. **No quedaba nada escrito.** La pregunta «¿le llegó la notificación?» no
   tenía más respuesta que creerse a quien la recibió.
2. **Llegaba a un solo aparato.** `UsersDeviceToken` guarda un token por
   persona. Quien tiene el teléfono y el navegador abiertos son dos destinos, y
   el aviso solo iba a uno.
3. **Si fallaba, se perdía.** Sin reintento y sin registro del motivo.

Con la cola se gana el registro, el reintento y el envío a todos los aparatos.

**Lo que cuesta:** el aviso deja de salir en el instante y sale en el minuto
siguiente. Para avisos de trabajo —una consigna nueva, una reasignación— ese
minuto no cambia nada. Si alguna vez hiciera falta uno de verdad inmediato, lo
que hay que hacer es **despertar al job al encolar**, no volver a saltarse la
cola.

## 3. Dónde vive el token: en la sesión

En `MOB_UserSessions.PushToken`, no en una tabla aparte.

Esa tabla ya es una fila por (usuario, aparato), que es justo la granularidad
que necesita una notificación, y resuelve gratis la pregunta difícil: **cerrar
sesión deja de mandar avisos a ese aparato**.

La trampa que trae, y que está resuelta en `avisos.js`: cuando FCM dice que un
token ya no existe se limpia **la columna**, nunca `RevokedOn`. Que el token
caduque no quiere decir que la persona tenga que volver a escribir su
contraseña.

## 4. Las cuatro fechas

Es la distinción que hace útil la bandeja. Ninguna sustituye a otra:

| Columna       | Quién la escribe          | Qué responde                          |
|---------------|---------------------------|---------------------------------------|
| `CreatedOn`   | quien encola              | cuándo se pidió el aviso              |
| `SentOn`      | `flujo_push.js`           | cuándo Google aceptó el mensaje       |
| `DeliveredOn` | el aparato                | cuándo se enseñó en la pantalla       |
| `OpenedOn`    | el aparato                | cuándo la persona lo tocó             |

«Salió» no es «llegó», y «llegó» no es «lo vio». Un teléfono apagado, la
aplicación sin permisos o un manotazo para descartarlo separan una de otra, y
esa distancia era invisible hasta ahora.

### Por qué el acuse va con una llave y no con el ID

El acuse lo manda el aparato, y en el navegador lo manda el **service worker**,
que corre fuera de la aplicación y no tiene sesión con la que autenticarse. En
el móvil puede mandarlo el manejador de fondo, con la aplicación cerrada.

`AckKey` es un GUID que viaja dentro del propio mensaje: solo lo tiene el
aparato al que se mandó y no sirve para nada más que para poner una fecha en esa
fila. Con el `ID` a secas, cualquiera podría contar de uno en adelante y marcar
como leídos los avisos de otra compañía.

Por eso la ruta `/public/push/acuse` es pública: no porque no importe, sino
porque quien tiene que llamarla no puede llevar sesión.

## 5. Las horas

**Todo se guarda en UTC. Siempre.**

Guardarlo en la hora de cada quien haría imposible ordenar la bandeja: dos
avisos de dos personas en husos distintos no se podrían comparar, y ese orden es
lo primero que se mira.

La zona se aplica **al leer**, y sale de la ficha de la persona:

```
Users.UTCCode  ──►  TimeZones.Code  ──►  ConvertionMins
   'BLQ'                                     -300
```

`ConvertionMins` son los minutos que hay que sumarle al UTC. La bandeja devuelve
los minutos, no la hora ya convertida, para que la pantalla pueda enseñar las
dos: la de la persona y la UTC. Hace falta cuando quien mira y quien recibió no
están en el mismo huso.

### Lo que esto NO hace: horario de verano

Existe `TimeZonesChanges` con los tramos, y **está sin mantener**:

| Código | Último tramo cargado |
|--------|----------------------|
| `EST`  | 2015                 |
| `CST`  | 2016                 |
| `PST`  | 2021                 |
| `MXC`  | 2027, pero **mal**: sigue afirmando un horario de verano que México abolió en 2022 |

Usarla daría horas peor que no usarla. Con el desfase base de `TimeZones`:

- los husos **sin** horario de verano quedan exactos — Colombia (`BLQ`), que son
  17.043 de los 25.110 usuarios, y también México, Venezuela, Perú, Ecuador;
- los que **sí** lo tienen quedan a una hora en verano — `EST` y `CST`, unos
  1.963 usuarios.

Y 2.410 usuarios no tienen zona puesta. Esos se marcan en la pantalla como «sin
zona · se enseña en UTC» en vez de enseñar UTC con su nombre encima: una hora
presentada como suya cuando no lo es acaba copiada en un correo y en una
discusión.

**Si algún día hace falta la hora exacta con horario de verano**, el arreglo no
es tocar esta pantalla: es poblar `TimeZonesChanges` o —mejor— pasar
`Users.UTCCode` a nombres IANA y dejar que la librería resuelva.

## 6. El push como acción de un flujo

Una regla puede pedir un aviso igual que pide un correo. El endpoint es el
**gemelo exacto** del de correo, a propósito: misma forma de llamar, mismo
contrato de respuesta, misma llave de deduplicación.

```
PUT /encolarPushDeFlujo
{
  answerGUID: '…',              // la actividad. Obligatoria.
  llave:      '…',              // lo que hace único este aviso
  para:       [771295, '@asignado'],
  titulo:     'Revisión vencida',
  cuerpo:     'La sede Norte quedó en rojo',
  imagen:     'https://…',      // la foto de un campo, ya resuelta
  enlace:     'https://…',
  regla:      '…',
  programado: '2026-09-05T14:00:00Z',
  disparo:    'boton' | 'guardar'
}
→ { ok: true, nuevo: true, personas: 2 }
```

Responde igual que el correo, y los clientes lo tratan con el mismo código de
cola: `reintentar: false` descarta, `reintentar: true` vuelve a pedirlo en la
siguiente sincronización. El `409` «la actividad todavía no está en Visitrack»
es el caso normal del móvil offline, no un fallo.

### Cómo se configura, y dónde vive el código

La acción se llama `enviar-push` y existe en los **tres motores**, que son
gemelos y corren la misma batería de casos (`CloudGoldFront/src/app/core/flujos/
casos.json`, copiada al móvil en `test/assets/flujos_casos.json`).

| Pieza | Dónde |
|-------|-------|
| El original del motor | `CloudGoldFront/src/app/core/flujos/motor.ts` |
| Su copia sincronizada | `WebVisitrack/src/app/core/forms/flujo-motor.ts` |
| El gemelo en Dart | `vtmobileplusnew/lib/Models/VisitrackForm/Flujos/motor.dart` |
| La ficha del diseñador | `.../flujos/tablero/tablero.component.{ts,html}` |
| La cola del web | `WebVisitrack/src/app/core/services/push-flujo.service.ts` |
| La cola del móvil | `vtmobileplusnew/lib/Providers/VisitrackForm/Sync/PushFlujoService.dart` |

Se configura en **Flujos → la regla → «enviar una notificación»**, y también
dentro de un botón. Es la misma ficha en los dos sitios, igual que el correo.

Lo que la ficha ofrece: a quién (los dos botones `@asignado` / `@creador`, más
identificadores y variables), título, texto, la foto de un campo, el enlace, y
las dos marcas de siempre —«solo si quedó completa» y «puede repetirse»—.

### La foto sale del campo, no de una dirección

Se guarda el **nombre del campo** y el motor lo resuelve con la misma maquinaria
que `{FOTO.url}`. Si el campo quedó vacío el aviso sale igual, sin imagen: uno
sin foto sirve; uno que no llega, no.

Al hacer esto apareció un fallo real que llevaba tiempo ahí y que afectaba
también al correo: `armarBoton` no le pasaba `urlDeBinarios` a `correoDeFlujo`.
Es el último parámetro y tiene valor por omisión, así que omitirlo no daba
error — la foto salía **en los correos de regla y no en los de botón**, con la
misma configuración escrita. Estaba en los tres motores; está corregido en los
tres.

### El botón ya no dice «todavía no se envía»

Antes la acción se configuraba, se guardaba y no salía nada: el motor la anotaba
en `pendientes` y el formulario lo confesaba. Ahora se arma de verdad.

`pendientes` **se queda**, pero solo para lo que de verdad no va a poder salir:
un aviso sin destinatario, o sin texto. Eso no es una promesa incumplida del
producto, es una configuración a medias, y el botón lo dice con su motivo
(`problemasDelPush`).

### Van personas, no direcciones

Es la única diferencia de fondo con el correo. Un correo se manda a una
dirección; un push se manda a **alguien**, y a cuál de sus aparatos lo decide el
servidor mirando sus sesiones vivas. El aparato no sabe —ni tiene por qué
saber— con qué teléfonos ha entrado un compañero.

Además de números de usuario se admiten dos palabras, que se resuelven **en el
servidor** contra la actividad de verdad:

| Palabra      | A quién                                  |
|--------------|------------------------------------------|
| `@asignado`  | a quien está asignada la actividad ahora |
| `@creador`   | a quien la creó                          |

Se resuelven ahí y no en el cliente porque un flujo se configura una vez y lo
diligencia gente distinta cada día: un identificador fijo acertaría hoy y
fallaría mañana. Y el aparato solo conoce a quien la tiene abierta, que no
siempre es el asignado.

### La compañía se comprueba

Los destinatarios tienen que ser de la misma compañía que la actividad, y eso se
verifica en el servidor. Sin esa comprobación, poner un número cualquiera en un
flujo mandaría avisos a usuarios de otro cliente: los identificadores son
secuenciales y probar mil seguidos no cuesta nada.

Importa especialmente en los **enlaces públicos**, donde quien dispara el flujo
no ha iniciado sesión: sin esto, repartir la dirección de un enlace sería
repartir la capacidad de notificar a cualquiera.

### Una fila por persona

La cola es una fila por (aviso, persona) — es lo que permite decir «a Pedro le
llegó y a Ana no». Por eso la llave de deduplicación lleva el usuario dentro:
sin él, el índice único dejaría pasar al primer destinatario y rechazaría a los
demás como repetidos.

### Cada plataforma necesita una forma distinta del mensaje

Y esto no es un detalle de estilo: mandar el mismo mensaje a las dos hacía que
**en el navegador llegaran dos notificaciones por cada aviso**.

Con el bloque `notification` presente, el navegador pinta una por su cuenta —sin
nuestro icono, sin nuestro enlace y sin la llave del acuse— y nuestro service
worker pinta otra. Quien lo recibe ve el mensaje repetido, y solo una de las dos
lleva a algún sitio al tocarla.

| Plataforma | Qué se manda | Por qué |
|------------|--------------|---------|
| `web` | **solo `data`** | el navegador no pinta nada solo, y la única que sale es la nuestra |
| `android` | `notification` + `data` | con la aplicación cerrada es el sistema quien la pinta; sin ese bloque no saldría nada |

Se decide en `pushFCM.js` mirando `plataforma`, que `avisos.js` saca de
`MOB_UserSessions.Platform`. El título y el texto viajan **siempre** dentro de
`data` además de donde toque, que es de donde ya los leían el service worker y
`push.service.ts`.

### El service worker tiene que devolver la promesa

`onBackgroundMessage` debe devolver lo que encadene `showNotification`. Sin eso,
el navegador puede matar al trabajador en cuanto el manejador retorna y **la
notificación no llega a pintarse**.

El fallo era invisible desde el servidor: el acuse sí llegaba —va con
`keepalive: true`, que le deja sobrevivir a la muerte del worker— así que la fila
decía «entregado» mientras en la pantalla no había aparecido nada. Los dos
síntomas juntos, acuse sí y notificación no, solo encajan con esto.

### De dónde sale la foto de un aviso

Un campo `image` **no se responde: pinta**. No aparece en `JSONAnswers` —se
comprobó contra actividades reales— así que no hay ningún `val` que leer. Su
dirección vive en dos sitios, y los dos valen:

1. **La propiedad `url` del campo**, puesta al diseñar el formulario. Es la
   opción sin sorpresas: no depende de reglas ni de momentos.
2. **Lo que ponga la acción `poner-imagen`** de una regla. Los clientes le pasan
   al motor la dirección que el campo **está enseñando ahora**, no la original —
   en el web desde `estadoFlujo()`, en el móvil con `flujoImagen ?? url`, la
   misma precedencia que usa el widget para pintarlo.

Un campo `picture` o `signature` guarda el GUID del binario, y con él se arma
`WebResource.aspx?e=PICTURE&id=<guid>`. **Los dos usan `PICTURE`**: una firma se
sirve por el mismo recurso que una foto. Lo que cambia es la forma del valor, y
las dos están cubiertas y con casos en la batería:

| Tipo | Cómo lo guarda |
|------|----------------|
| `picture` | `{val: '<guid>'}` |
| `signature` | `{val: {bin: '<guid>'}}` — anidado |

### La foto está en línea antes de que salga el aviso, y sale gratis

No hizo falta añadir nada: lo garantiza el **gate de binarios** que ya existía.

Una actividad no se crea en Visitrack hasta que sus archivos están confirmados
en el bucket —estados `0` y `1` bloquean el envío; ver `docs/binarios-en-linea.md`—
y un aviso solo se encola contra una actividad **que ya existe**: si no está, el
servidor responde `409` y el cliente reintenta.

De ahí sale la garantía, por construcción:

> hay push ⟹ la actividad existe ⟹ sus binarios están en línea

Sin eso, un aviso con la foto de un campo llegaría con la imagen rota justo en
los primeros segundos, que es cuando alguien lo mira.

### Los despachos que llegan por sincronización también avisan

Hay dos momentos en que alguien recibe una consigna, y hasta ahora solo uno
avisaba:

| Cómo llega | Quién avisa |
|------------|-------------|
| la despacha una regla de flujo | `avisarDelDespacho`, al crearla |
| entra por sincronización (entidad 9) | `getAnswersByUserVtPlus`, al entregarla |

El segundo no avisaba a nadie. Ahora sí, y a **todos** los aparatos de esa
persona, porque el aviso va por `encolarAviso` y el servidor mira sus sesiones
vivas.

**Una por tanda, no una por sincronización.** Ese endpoint se llama en cada
sincronización del móvil, así que sin llave quien sincroniza cada pocos minutos
recibiría el mismo aviso una y otra vez. Y con una llave por día solo llegaría el
primero, callando los despachos de la tarde.

La llave lleva **cuántas hay y cuál es la última**: mientras la tanda sea la
misma no se repite, y en cuanto entre una consigna nueva el identificador más
alto cambia y sale otro aviso.

```js
dedupeKey: `despachos:${userId}:${cuantos}:${ultimo}`
```

**Y no puede tumbar la sincronización.** Va en su propio `try` aunque
`encolarAviso` ya prometa no lanzar: lo que esa función tiene que hacer es
entregar las consignas, y un fallo avisando no puede impedir que lleguen. La
promesa de una función de otro archivo no es una garantía comprobable desde ahí.

## 7. Los archivos

### cloud-server

| Archivo | Qué hace |
|---------|----------|
| `sql/VTServicesPushOutbox.sql` | la cola |
| `sql/VTServicesPushOutbox_acuses.sql` | le añade `AckKey`, `DeliveredOn`, `OpenedOn` |
| `sql/MOB_UserSessions_push.sql` | el token en la sesión |
| `sql/md_push_programadas.sql` | las alertas que salen solas |
| `providers/PushNotification/pushFCM.js` | habla con FCM v1 |
| `providers/PushNotification/avisos.js` | `enviarAUsuario`, `encolarAviso`, `registrarToken` |
| `providers/jobs/flujo_push.js` | vacía la cola, cada minuto |
| `providers/jobs/push_programadas.js` | encola las alertas que tocan |
| `controllers/Services/pushDeFlujo.js` + `routes/Services/pushDeFlujo.js` | la acción `enviar-push` de un flujo |
| `controllers/Push/Acuses.js` + `routes/Push/Acuses.js` | recibe los acuses |

### Los clientes

| Archivo | Qué hace |
|---------|----------|
| `WebVisitrack/public/firebase-messaging-sw.js` | recibe con la pestaña cerrada; acusa entrega y apertura |
| `WebVisitrack/src/app/core/services/push.service.ts` | pide permiso, registra el token, escucha en primer plano |
| `vtmobileplusnew/lib/Providers/Push/push-service.dart` | lo mismo en el teléfono, más el isolate de segundo plano |

### Module

`push-alerts` en cloud-gold sirve el CRUD y la bandeja; en CloudGoldFront viven
`list-push-alerts` y `push-outbox`, en **Configuración → Alertas**.

## 8. Lo que **no** se ha comprobado

Se dice porque conviene saberlo antes de darlo por bueno:

### Lo que ya está comprobado contra la realidad

- **Un navegador ha recibido avisos por este camino**, y los ha acusado: hay
  filas con `SentOn`, `Entregados = 1` y `DeliveredOn` puesto.
- **El servidor guarda la imagen.** Se insertó una fila por el endpoint real con
  `imagen` y quedó con la URL completa en la columna `Image`.
- **El endpoint de flujo funciona de extremo a extremo** contra una actividad
  real: la encuentra, resuelve la compañía y rechaza a un destinatario que no
  existe sin insertar nada.
- **El token de web es válido** ante FCM, comprobado con `validate_only`.

### Lo que sigue sin comprobarse

- **Ningún teléfono Android ha recibido un aviso todavía.** Todo lo probado ha
  sido en navegador.
- **El acuse de apertura (`OpenedOn`) no se ha visto llenarse.** El de entrega
  sí.
- **Falta un script por correr.** De los cuatro, tres ya están aplicados en
  `10.0.1.20/Visitrack`; el que falta es `sql/md_push_programadas.sql`, y sin él
  la pantalla de alertas programadas responde «Invalid object name». Los objetos
  que toca —`cg_permissions`, `cg_roles`, `cg_role_permissions`,
  `cg_package_permissions`— y sus columnas se verificaron contra la base real.
- **Lo que sí está comprobado del motor:** la batería compartida pasa entera en
  los tres —504 casos en TypeScript, 549 pruebas en Dart— con 12 casos nuevos
  para el push. Se comprobó que esos casos *pueden* fallar saboteando uno a
  propósito: un caso que no puede fallar no prueba nada.
- **iOS está fuera**, por decisión explícita. Falta el certificado APNs.
- **Una notificación que no aparece puede no ser culpa del código.** Cuando
  Windows tiene las notificaciones apagadas para Chrome, `showNotification`
  **resuelve igualmente** y no se ve nada. Antes de buscar en el código, el test
  que lo separa es `navigator.serviceWorker.ready.then(r => r.showNotification('x'))`
  en la consola: si resuelve y no aparece, el bloqueo es del sistema.
- **La tasa de apertura será baja al principio** y no querrá decir que nadie
  lea: los avisos que salieron antes de este cambio no tienen `AckKey` y nunca
  se acusarán.
