# Servicio de login — `GET /loginTemp`

Contrato del servicio de autenticación: qué recibe, qué devuelve y qué responde
cuando algo falla.

**Implementación:** `cloud-server/src/controllers/Users/Users.js` → `loginTemp()`.
Ruta declarada en `src/routes/Users/Users.js`. Emisión del token en
`src/providers/auth/sessions.js`.

---

## Endpoint

```
GET https://vtmobileplus.visitrack.com/loginTemp
```

| | |
|---|---|
| **Método** | `GET` |
| **Autenticación** | Ninguna. Está en `PUBLIC_PATHS` del middleware: es la ruta que entrega el token, y exigirlo aquí sería un círculo. |
| **Respuesta** | JSON |
| **Detrás** | El procedimiento almacenado `sp_LoginAndUpdateDevice_Detailed`, más dos consultas de rol y permisos, más la emisión de la sesión. |

El nombre lo dice a medias: además de autenticar, **actualiza el equipo** desde
el que se entra. Por eso `deviceid` es obligatorio.

---

## Parámetros

Todos en la cadena de consulta.

| Parámetro | Obligatorio | Va al SP como | Qué es |
|---|---|---|---|
| `user` | **Sí** | `@LoginUser` | Usuario o correo. |
| `password` | **Sí** | `@PasswordInput` | Contraseña en claro. |
| `deviceid` | **Sí** | `@NewDeviceID` | Identificador del equipo. Es la llave con la que se registra la sesión. |
| `platform` | No | — | Nombre con el que se ve la sesión al listarla. Si no viene, el servidor pone **`movil`**. |
| `devicename` | No | — | Descripción legible del equipo. Si no viene, queda `null`. |

Faltando cualquiera de los tres primeros, el servicio **no llega a la base de
datos**: responde `400` de inmediato.

```
/loginTemp?user=juan@empresa.com&password=SECRETO&deviceid=a1b2c3&platform=web&devicename=Chrome%20en%20Windows
```

> **La contraseña viaja en la URL.** Un `GET` con la credencial en la cadena de
> consulta queda en los accesos del servidor, en los proxys intermedios y en
> cualquier caché — sitios donde nadie va a buscar una contraseña y, por eso
> mismo, nadie la borra. TLS protege el tránsito, no el registro. Cambiarlo a
> `POST` obliga a mover el servidor y los dos clientes a la vez, así que queda
> anotado como decisión pendiente y no como descuido.

---

## Respuesta correcta

**HTTP 200** con `status: true`. En `response` va lo que devolvió el
procedimiento —tal cual, con las columnas que tenga— más cinco campos que agrega
el controlador.

```json
{
  "status": true,
  "response": {
    "ID": 1234,
    "CompanyID": 2259,
    "FirstName": "Juan",
    "AccessToken": "…",

    "RoleID": 7,
    "RoleName": "Inspector",
    "RoleCode": "INSP",
    "permissions": [{ "moduleKey": "forms", "permissionCode": "read" }],

    "token": "eyJhbGciOi…",
    "tokenExpiresOn": "2026-09-13T12:00:00.000Z"
  }
}
```

Lo que agrega el controlador:

| Campo | De dónde sale |
|---|---|
| `RoleID`, `RoleName`, `RoleCode` | `UserRoles` × `Roles` |
| `permissions` | `ModulePermissions` × `Modules` × `Permission`, como `{ moduleKey, permissionCode }` |
| `token`, `tokenExpiresOn` | La sesión recién emitida |

**El resto de columnas las pone el procedimiento** y pueden variar según la
compañía. Quien consuma esto debe tomar las que conoce e ignorar el resto, no
validar la forma completa.

### El token

Es un **JWT firmado por este servidor**, con `uid`, `cid`, `did` (el `deviceid`) y
`plt`. Dura **30 días** (`TTL_DAYS` en `sessions.js`).

No confundirlo con `AccessToken`, que ya venía en la tabla `Users` e identifica al
usuario en la plataforma .NET: aquél no dice nada sobre si esta sesión sigue
abierta. El que viaja después en `x-token` es `token`.

Al emitirlo, **la sesión anterior de ese mismo equipo se reemplaza** — volver a
entrar en el mismo teléfono no deja la anterior viva por ahí. Las de otros
equipos no se tocan; ese es el motivo de que la tabla de sesiones exista.

### Dos fallos que no impiden entrar

Están así a propósito, y hay que conocerlos porque **la respuesta sigue siendo
`status: true`**:

| Si falla | Qué llega | Por qué no bloquea |
|---|---|---|
| Rol y permisos (tablas ausentes, consulta caída) | `RoleID: 0`, `RoleName: ""`, `RoleCode: ""`, `permissions: []` | Quedarse fuera por no poder leer los permisos es peor que entrar sin ellos. |
| Emisión del token (sin `JWT_SECRET`, error al registrar) | `token: ""`, `tokenExpiresOn: null` | Mientras el servidor esté en modo gracia, una sesión sin token funciona. |

Un `token` vacío es la señal de que **ese despliegue no maneja sesiones**: no
podrá listar equipos conectados ni cerrar sesiones remotas.

---

## Respuestas de error

Son tres, y la diferencia entre ellas importa más de lo que parece.

### 1 · Faltan parámetros → **HTTP 400**

```json
{ "error": "Faltan parámetros" }
```

Ojo: esta respuesta **no lleva el campo `status`**. Quien compruebe solo
`status === true` la leerá como un fallo, que está bien, pero quien busque el
motivo en `message` no lo encontrará — aquí el campo es `error`.

### 2 · El procedimiento rechazó → **HTTP 400**

Es el rechazo normal: usuario o contraseña que no valen, cuenta bloqueada.
Cualquier `RAISERROR` del procedimiento llega aquí, con su texto íntegro:

```json
{ "status": false, "message": "Contraseña incorrecta." }
```

Mensajes conocidos: `Contraseña incorrecta.` y `El usuario no está activo.` La
lista completa vive en el procedimiento, en la base de datos.

Ese texto está pensado para enseñarse tal cual: distingue una contraseña mal
escrita —que se arregla escribiéndola bien— de una cuenta desactivada, que no se
arregla intentándolo otra vez.

### 3 · Falló algo antes de la consulta → **HTTP 200**

Sin conexión a la base de datos, o cualquier error fuera del bloque de la
consulta:

```json
{ "status": false, "error": "..." }
```

**Responde 200.** El `catch` exterior usa `res.json(...)` sin fijar código, y el
valor por omisión de Express es 200. Un cliente que se guíe por el código HTTP
dará por buena la entrada; el único indicio de que algo falló es `status: false`.
Y el texto de `error` es el mensaje de la excepción de JavaScript, no un mensaje
para nadie.

### Resumen

| Situación | HTTP | Campo con el motivo | `status` |
|---|---|---|---|
| Entrada correcta | 200 | — | `true` |
| Falta `user`, `password` o `deviceid` | **400** | `error` | *(ausente)* |
| Credenciales o estado rechazados por el SP | **400** | `message` | `false` |
| Fallo de conexión o error interno | **200** | `error` | `false` |

**Regla para integrar:** mirar `status === true` primero y el código HTTP después,
y buscar el motivo en `message` **y** en `error` — ninguno de los dos está en
todas las respuestas.

### Lo que este servicio nunca devuelve

**Un 401.** No puede: es la llamada que crea la sesión, así que no hay ninguna que
rechazar. Si llega un 401 desde esta ruta, no viene del servicio — viene de un
proxy o del servidor de aplicaciones que lo aloja.

Importa porque en **el resto** de rutas de este backend un 401 sí significa «esta
sesión ya no vale» y obliga a cerrarla. Aplicar aquí ese mismo criterio hace que
escribir mal la contraseña se trate como una expulsión.

### Cuando la respuesta no es JSON

Ocurre: una página de error de IIS o Apache, un portal cautivo que intercepta, un
cuerpo vacío. El cuerpo empieza por `<` y cualquier intento de interpretarlo como
JSON revienta.

No sale de este controlador —sale de lo que hay delante—, pero llega igual, así
que hay que comprobarlo antes de decodificar. Dar por sentado que un no-200 trae
JSON es lo que convierte «el servidor de aplicaciones está caído» en «respuesta
inválida», un mensaje con el que no se puede averiguar nada.

---

## Probarlo a mano

```bash
curl -i "https://vtmobileplus.visitrack.com/loginTemp\
?user=USUARIO&password=CLAVE&deviceid=prueba-001&platform=web&devicename=curl"
```

Qué mirar, en orden:

1. **`status`**, antes que el código HTTP. Un 200 no garantiza nada: el error
   interno también responde 200.
2. **`message` y `error`**. El motivo está en uno de los dos.
3. **`response.token`**. Vacío significa que ese despliegue no emite sesiones —
   probablemente le falta `JWT_SECRET`.
4. **`response.permissions`**. Vacío con `RoleID: 0` significa que las tablas de
   rol no respondieron; el login funcionó igual.
5. **Si el cuerpo empieza por `<`**, no estás hablando con la API.

Usa un `deviceid` de prueba y distinto del de un equipo real: la llamada
**reemplaza la sesión de ese equipo**, así que reutilizar el identificador de un
teléfono en producción lo echa de su sesión.

---

## Servicios relacionados

Del mismo backend, todos exigiendo `x-token` salvo donde se indica:

| Servicio | Para qué |
|---|---|
| `POST /logout` | Cierra la sesión del token con el que se llama; con `DeviceID` en el cuerpo, la de otro equipo del mismo usuario. **Es ruta pública**: si exigiera sesión válida, el caso más común —la sesión caducó y el cliente quiere limpiar— respondería 401 y el cliente reaccionaría cerrando sesión otra vez, en bucle. No abre nada, porque sin token no revoca nada. |
| `GET /mySessions` | Sesiones abiertas del usuario. Sirve además para saber si un token sigue valiendo: si responde la lista, el servidor lo aceptó. |
| `POST /closeSession` | Cierra una sesión concreta o todas menos la actual. Exige la contraseña y responde **403** con el motivo en `error` si no es correcta. |
| `GET /getCompanyLogo` | **Ruta pública**: se pinta en la pantalla de inicio de sesión, antes de que haya sesión. |

---

## Dos cosas que conviene revisar

Salieron al leer el controlador. No las toqué —es otro repositorio— pero dejarlas
sin escribir sería peor.

**El error interno responde 200.** Está en el `catch` exterior: `res.json(...)`
sin código, y Express pone 200. Un fallo de conexión a la base de datos llega
como una respuesta aparentemente correcta, y el cliente solo lo distingue si mira
`status`. Un `res.status(500)` ahí lo arregla.

**Si el procedimiento devuelve cero filas sin lanzar error**, `userData` queda
`undefined`. Lo que sigue no se cae —leer `.ID` de `undefined` ocurre dentro de
bloques que capturan su propia excepción, y esparcir `undefined` en un objeto no
lanza—, así que la respuesta sería **200 con `status: true`**, sin datos de
usuario, sin token y sin permisos: un login «correcto» que no autenticó a nadie.
Depende de que el procedimiento siempre lance `RAISERROR` en vez de devolver
vacío; hoy no hay nada en el controlador que lo garantice.

---

