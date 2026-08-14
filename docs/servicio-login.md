# Servicio de login — `GET /loginTemp`

Contrato del servicio de autenticación: qué recibe, qué devuelve y qué responde
cuando algo falla.

> **De dónde sale esto.** El código del backend no está en este repositorio. El
> contrato descrito aquí está reconstruido a partir de los **dos clientes que lo
> consumen** —la aplicación web y la app móvil— que coinciden en los parámetros
> que envían y en las formas de respuesta que interpretan. Los mensajes de error
> citados son los que los clientes reconocen por su texto. Lo que no pude
> verificar contra el servidor está señalado al final.

---

## Endpoint

```
GET https://vtmobileplus.visitrack.com/loginTemp
```

| | |
|---|---|
| **Método** | `GET` |
| **Autenticación** | Ninguna. Es la llamada que **produce** el token, así que no lleva `x-token`. |
| **Formato de respuesta** | JSON |
| **Detrás** | El procedimiento almacenado `sp_LoginAndUpdateDevice_Detailed`, más el rol y los permisos que agrega el controlador. |

El nombre lo dice: además de autenticar, **da de alta o actualiza el equipo**
desde el que se entra. Por eso `deviceid` no es opcional en la práctica aunque el
servicio responda sin él.

---

## Parámetros

Todos van en la cadena de consulta.

| Parámetro | Obligatorio | Qué es |
|---|---|---|
| `user` | Sí | Usuario o correo. Los clientes lo envían recortado y **en minúsculas**, para que `Juan@…` y `juan@…` sean la misma cuenta. |
| `password` | Sí | Contraseña en claro. Ver la advertencia de abajo. |
| `deviceid` | Sí | Identificador estable del equipo. Es la llave con la que el servicio registra la sesión y con la que después se lista o se cierra. |
| `platform` | No | Con qué nombre se ve esta sesión al listarla. Los clientes envían `web` y `movil`. |
| `devicename` | No | Descripción legible del equipo. Puramente informativa. |

Ejemplo:

```
/loginTemp?user=juan@empresa.com&password=SECRETO&deviceid=a1b2c3&platform=web&devicename=Chrome%20en%20Windows
```

> **La contraseña viaja en la URL.** Un `GET` con la credencial en la cadena de
> consulta queda registrado en los accesos del servidor, en los proxys que haya
> de por medio y en cualquier caché intermedia — sitios donde nadie va a buscar
> una contraseña, y precisamente por eso nadie la borra. TLS protege el tránsito,
> no el registro. Moverlo al cuerpo de un `POST` es un cambio de servidor y de
> los dos clientes a la vez, así que queda anotado como decisión pendiente y no
> como descuido.

---

## Respuesta correcta

**HTTP 200** con `status: true`. Los datos del usuario van en `response`.

```json
{
  "status": true,
  "response": {
    "ID": 1234,
    "GUID": "…",
    "CompanyID": 2259,
    "FirstName": "Juan",
    "LastName": "Pérez",
    "Email": "juan@empresa.com",
    "token": "…",
    "tokenExpiresOn": "2026-09-01T12:00:00Z",
    "AccessToken": "…",
    "UTCCode": "-5",
    "DefaultLanguage": "es",
    "Active": 1,
    "Phone": "…",
    "StatusID": "…",
    "WorkZoneID": 12,
    "GroupID": 3,
    "DivisionID": 1,
    "RoleID": 7,
    "RoleName": "Inspector",
    "RoleCode": "INSP",
    "permissions": [{ "moduleKey": "forms", "permissionCode": "read" }]
  }
}
```

### Los dos tokens

Son distintos y conviven:

| Campo | Qué identifica | Vigencia |
|---|---|---|
| `token` | **La sesión** en este servidor. Es el que viaja después en la cabecera `x-token`. | La dice `tokenExpiresOn`. Se invalida al cerrar la sesión, propia o desde otro equipo. |
| `AccessToken` | **Al usuario** en la plataforma .NET. No dice nada sobre si la sesión sigue abierta. | La suya, ajena a este servicio. |

`token` es **opcional**: los despliegues que aún no lo emiten responden sin él, y
los clientes caen a `AccessToken`. Un servidor sin `token` es un servidor sin
sesiones: no puede invalidar nada ni listar equipos conectados.

### El resto de columnas

`response` puede traer **columnas adicionales** según la compañía, porque el
procedimiento almacenado no devuelve siempre el mismo juego. Quien consuma esto
debe tomar las que conoce e ignorar el resto en vez de validar la forma completa.

---

## Respuestas de error

Hay tres formas distintas y conviene no confundirlas.

### 1 · HTTP 200 con `status: false`

Credenciales rechazadas por la lógica de negocio. El motivo va en `message`.

```json
{ "status": false, "message": "Contraseña incorrecta." }
```

Es la forma **normal** del rechazo: el servicio funcionó y su respuesta es «no».

### 2 · HTTP distinto de 200, con cuerpo JSON

El detalle sigue viniendo en `message`, y ahí es donde llegan los `RAISERROR` del
procedimiento almacenado:

```json
{ "message": "El usuario no está activo." }
```

Mensajes observados que los clientes reconocen tal cual:

- `Contraseña incorrecta.`
- `El usuario no está activo.`

Ese texto está pensado para enseñarse al usuario sin traducir: distingue una
contraseña mal escrita —que se arregla escribiéndola bien— de una cuenta
desactivada, que no se arregla intentándolo otra vez.

### 3 · HTTP distinto de 200, con cuerpo que **no es JSON**

Ocurre de verdad y hay que contarlo: una página de error de IIS o Apache, un
portal cautivo que intercepta, un cuerpo vacío. El cuerpo empieza por `<` y
`json.decode` revienta con él.

No es un caso teórico — los dos clientes lo detectan mirando si el cuerpo empieza
por `<` antes de intentar interpretarlo, y caen a un mensaje genérico con el
código HTTP. Quien integre contra este servicio tiene que hacer lo mismo: dar por
sentado que un no-200 trae JSON es lo que convierte «el servidor de aplicaciones
está caído» en «respuesta inválida», un mensaje que no permite averiguar nada.

### 4 · Sin respuesta

Tiempo de espera agotado o fallo de transporte. **No** es un rechazo de
credenciales: el servicio no llegó a opinar. Los clientes usan 20 y 30 segundos
de espera y distinguen este caso del rechazo, porque es el que permite entrar con
lo que haya guardado localmente.

### Resumen

| Situación | HTTP | Cuerpo | Cómo distinguirla |
|---|---|---|---|
| Entrada correcta | 200 | `status: true` + `response` | — |
| Credenciales rechazadas | 200 | `status: false` + `message` | `status` es `false` |
| Error del procedimiento | ≠ 200 | `{ "message": … }` | No-200 y el cuerpo interpreta |
| Servidor de aplicaciones caído | ≠ 200 | HTML | El cuerpo empieza por `<` |
| Sin salida a internet | — | — | Excepción de transporte o vencimiento |

### El campo `error`

Aparte de `message`, la respuesta admite un campo `error`. En el resto de
servicios de este backend —los que sí exigen `x-token`— es el que trae el motivo
de un **401**, y de ahí lo lee quien decide cerrar la sesión. En `/loginTemp` el
campo que llevan los rechazos es `message`; conviene leer los dos y quedarse con
el primero que traiga texto.

---

## Un 401 aquí no significa lo mismo que en el resto

En cualquier otro servicio de este backend, un **401** significa «esta sesión ya
no vale» y obliga a cerrarla.

En `/loginTemp` no puede significar eso: es la llamada que crea la sesión, así que
no hay ninguna que invalidar. Aquí un 401 es «estas credenciales no sirven», que
es información para quien está escribiéndolas, no motivo para expulsar a nadie.

Confundir los dos casos produce un fallo desconcertante: intentas entrar con la
contraseña mal escrita y la aplicación te trata como si te hubieran echado.

---

## Probarlo a mano

```bash
curl -s "https://vtmobileplus.visitrack.com/loginTemp\
?user=USUARIO&password=CLAVE&deviceid=prueba-001&platform=web&devicename=curl"
```

Qué mirar, en este orden:

1. **El código HTTP** (`curl -i`). Un 200 no garantiza que entraste: hay que
   mirar `status`.
2. **`status`**. Si es `false`, la razón está en `message`.
3. **Si `response.token` viene**. Sin él, ese despliegue no maneja sesiones: no
   podrá listar equipos conectados ni cerrar sesiones remotas.
4. **Si el cuerpo empieza por `<`**. Entonces no estás hablando con la API sino
   con el servidor de aplicaciones que la aloja.

Usa un `deviceid` de prueba y distinto del de un equipo real: la llamada **da de
alta o actualiza el equipo**, y reutilizar el identificador de un teléfono en
producción tocaría su registro.

---

## Servicios relacionados

Del mismo backend y con la misma sesión:

| Servicio | Para qué |
|---|---|
| `POST /logout` | Cierra la sesión actual. |
| `GET /mySessions` | Sesiones abiertas del usuario. Sirve además para comprobar si el token sigue valiendo: si responde la lista, el servidor lo aceptó. |
| `POST /closeSession` | Cierra una sesión concreta o todas menos la actual. Exige la contraseña y responde **403** con el motivo en `error` cuando no es correcta. |

Todos esos sí exigen la cabecera `x-token`.

---

## Lo que no pude verificar

Sin el código del servidor delante, queda pendiente de confirmar:

- **Qué código HTTP acompaña a cada error.** Los clientes tratan «no-200» como un
  bloque y no distinguen 400 de 401 de 500, así que no puedo afirmar cuál emite
  el servicio en cada caso.
- **La lista completa de mensajes del procedimiento almacenado.** Los dos citados
  son los que aparecen escritos en los clientes; es de esperar que haya más.
- **Si `deviceid` es obligatorio del lado del servidor** o solo en la práctica.
- **Cuánto dura `token`** y si el servicio lo renueva al volver a entrar desde el
  mismo `deviceid`.
- **Si `platform` acepta valores distintos de `web` y `movil`**, o es texto libre.

Con acceso al repositorio del backend cierro estos cinco puntos y el documento
pasa a estar verificado contra la fuente.
