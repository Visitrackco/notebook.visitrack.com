# El login: cómo se usa y contra qué servidor va

Qué pasa cuando alguien escribe su usuario y su contraseña, a dónde viaja eso, y
cómo cambiar el servidor sin recompilar.

---

## A qué servidor apunta

Todas las llamadas de sesión salen contra **una sola dirección base**, la que
resuelve `ApiService`:

```ts
// core/services/api.service.ts
private get baseUrl(): string {
  return environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
}
```

Por omisión:

| Ajuste | Valor | Qué es |
|---|---|---|
| `apiUrl` | `https://vtmobileplus.visitrack.com` | Sincronización, login y archivos (Node). El mismo que usa la app móvil. |
| `platformUrl` | `https://api.visitrack.com` | API de la plataforma (.NET). **El login no la usa.** |
| `localApiUrl` | `http://localhost:100` | Backend local de desarrollo. |
| `useLocalApi` | `false` | Con `true`, todo va a `localApiUrl`. |

Que sea el mismo backend que el teléfono no es casualidad: es lo que permite que
una cuenta entre en los dos sitios, que los datos sean comparables y que un
traspaso entre equipos tenga sentido.

### Cambiar el servidor sin recompilar

La dirección **no está horneada** en el paquete. Al arrancar, la aplicación pide
`config.json` y lo que venga ahí pisa lo compilado
(`core/config/runtime-config.ts`). El servidor de Node lo genera en cada petición
desde sus variables de entorno:

```bash
API_URL=https://otro.servidor.com npm run serve:dist
```

O en un `.env` junto a `server.js`, que se relee en cada petición — se edita, se
recarga la página y ya apunta a otro sitio, sin reiniciar el proceso:

```
API_URL=https://preproduccion.visitrack.com
```

Variables disponibles: `API_URL`, `PLATFORM_URL`, `LOCAL_API_URL`,
`BINARIES_URL`, `USE_LOCAL_API`, `REQUEST_TIMEOUT`, `SYNC_INTERVAL_MINUTES`.
Plantilla completa en `.env.example`.

Con `ng serve` no hay `config.json` y quedan los valores de
`src/environments/environment.ts`. No falla: un arranque que se cae porque falta
un archivo opcional deja la pantalla en blanco sin decir por qué.

> **Ojo con `environment.prod.ts`.** Hoy es código muerto: `angular.json` no
> declara `fileReplacements`, así que la compilación de producción usa
> `environment.ts` — con `production: false`. Editar el archivo de producción no
> tiene ningún efecto.

---

## Entrar con usuario y contraseña

Es la vía normal. Una sola llamada:

```
GET {baseUrl}/loginTemp
    ?user=<login en minúsculas>
    &password=<contraseña>
    &deviceid=<identificador de este navegador>
    &platform=web
    &devicename=<descripción del navegador y el sistema>
```

- **`user`** se recorta y se pasa a minúsculas antes de salir, para que
  `Juan@…` y `juan@…` sean la misma cuenta.
- **`deviceid`** se genera la primera vez y vive en `localStorage`. Es lo que
  identifica a este navegador como un equipo más de la cuenta.
- **`platform`** y **`devicename`** son solo presentación: es el nombre con el
  que esta sesión aparece en el perfil y en el teléfono. Sin ellos la lista de
  sesiones sería una fila de identificadores.

La respuesta llega en `response`, y se acepta `body` por compatibilidad con
despliegues antiguos. Si `status` no es cierto, se enseña el mensaje del servidor
tal cual — «usuario o contraseña incorrectos» es información útil y no hay que
disfrazarla.

De lo que devuelve se guarda la cuenta en IndexedDB (`Users`) con `Session = '1'`,
y de ahí sale el **token**:

```ts
Token: data.token || data.AccessToken || ''
```

Se acepta el viejo `AccessToken` a propósito: mientras el backend no emita el
nuevo, o esté en modo gracia, se sigue mandando lo que haya y nada deja de
funcionar.

Después del login, dos cosas más que **no bloquean la entrada**: los permisos del
rol (si fallan se entra sin ellos y el menú enseña lo básico) y el logo de la
compañía, que se trae en segundo plano.

Al terminar se va a `/cargando`, que es la descarga de catálogos, y desde ahí a
`/inicio` — o a la dirección que se pidiera antes de que el guard mandara al
login.

---

## Entrar sin conexión

Si la llamada falla **por transporte** —no por credenciales— se intenta contra lo
que hay guardado:

```ts
if (apiError?.isNetworkError) { ... loginOffline(...) }
```

Condiciones, las dos a la vez:

1. Esa cuenta ya inició sesión antes **en este navegador**.
2. La contraseña coincide con la de la última sesión correcta.

La segunda no es un formalismo: sin ella, cualquiera entraría a la cuenta de otro
con solo desconectar la red.

Si no se cumplen, el mensaje lo dice entero: *«No hay conexión con el servidor y
esta cuenta no ha iniciado sesión antes en este dispositivo»*. La aplicación se
usa en campo, donde la señal falta justo cuando más se necesita; exigir servidor
para entrar la volvería inútil ahí.

> **Nota de seguridad.** Validar sin conexión obliga a conservar la credencial,
> igual que hace la app móvil. Está en IndexedDB, aislada por origen. Para
> endurecerlo, el camino es guardar un hash con `crypto.subtle` y comparar contra
> él. Queda escrito para que sea una decisión explícita y no un descuido.

---

## Entrar desde el teléfono

La tercera vía, y la única que **crea sesión sin contraseña**: se escanea un
código de un solo uso desde la app móvil y lo que viaja es la autenticación que
ya existe allí, junto con el trabajo que el teléfono no ha subido.

`AuthService.adoptFromLink()` monta la cuenta con los datos que llegan. **La
contraseña no viaja** —el teléfono no la guarda en claro y aquí no hace falta,
porque la sesión ya está creada—, así que queda vacía. Consecuencia práctica: una
cuenta que entró así **no puede entrar sin conexión** hasta que alguien inicie
sesión con contraseña al menos una vez en este navegador.

Dos protecciones:

- Si ya hay sesión abierta **de la misma persona**, no se toca nada.
- Si el teléfono trae **otra cuenta**, se cancela con un mensaje: son dos
  personas, y mezclar sus datos a mitad de un traspaso es peor que no vincular.

---

## Cómo viaja la sesión después

El token va en la cabecera **`x-token`**, igual que en la app móvil. Hay dos
caminos y los dos la ponen:

| Camino | Quién | Qué cubre |
|---|---|---|
| `HttpClient` | `core/interceptors/auth.interceptor.ts` | Casi toda la aplicación |
| `fetch()` | `core/services/api-fetch.service.ts` | Sincronización y traspasos: leen la respuesta como flujo o se cancelan con `AbortSignal` |

`/loginTemp` sale **sin** token: es la llamada que lo produce, y mandar uno viejo
ahí no aporta nada y estorba al diagnosticar.

Lo que no es del backend —el sonido de aviso, el logo de la plataforma, los
archivos de `/dispatchFile`— sigue con `fetch` a secas: no lleva sesión y no debe
llevarla.

---

## Cuándo se cierra la sesión

Un **401** es la señal, pero por sí solo no basta.

No todas las peticiones hablan de nuestra sesión: durante un traspaso entre
equipos hay llamadas que se autentican con el código del enlace, y su 401
significa «ese código no vale», no «tu sesión terminó». Cerrar por eso echaba de
la aplicación a quien tenía la sesión correcta abierta.

Por eso `SessionEndService` pregunta antes, con `GET /mySessions`:

| Respuesta | Veredicto | Qué hace |
|---|---|---|
| 200 con la lista | `valid` | No cierra: el 401 venía de otra cosa |
| 401 | `invalid` | Cierra, avisa y lleva al login |
| 500, 404, sin red, timeout | `unknown` | **No cierra**: no se pudo saber |

`unknown` no es un fallo, es un resultado. No poder preguntar no es lo mismo que
ser rechazado, y confundirlos deja fuera a quien solo se quedó sin cobertura.
Estar dentro de más se corrige en la siguiente petición que sí obtenga respuesta;
estar fuera de menos obliga a volver a entrar, y en campo eso puede significar no
poder trabajar.

La comprobación usa `fetch` con el token a mano y **no** `HttpClient`: pasando
por el interceptor, el comprobante dispararía el cierre que está comprobando.

El aviso sale una sola vez aunque fallen diez peticiones a la vez, y el motivo
que dio el servidor se conserva en la pantalla de login hasta que se vuelva a
entrar: quien llega al equipo un rato después necesita saber que no fue un fallo
de la aplicación.

---

## Varias cuentas en el mismo navegador

Se conservan todas las que hayan entrado, para poder alternar sin volver a
escribir credenciales — de ahí los botones de cuenta en el login. Solo una tiene
`Session = '1'`, invariante que garantiza `UserRepository`.

Las preferencias distinguen dos alcances (`appSettings`, con llave
`"<clave>::<UserID>"`):

- **Del dispositivo** (`UserID` vacío): tamaño de texto, tema. Compartidas.
- **Del usuario**: todo lo que cambie el comportamiento de los datos.

La distinción no es teórica. En la app móvil los ajustes eran globales y quien
desactivaba los borradores se lo imponía a cualquiera que entrara después en ese
equipo, pudiendo hacerle perder trabajo sin haberlo pedido nunca.

---

## Cerrar sesión

`AuthService.logout()` avisa al servidor con `POST /logout` y limpia la sesión
local. El interceptor deja pasar esa llamada sin tratar su 401: el propio cierre
de sesión no puede desencadenar otro cierre de sesión.

---

## Diagnóstico

**Comprobar a qué servidor apunta de verdad.** El servidor de Node lo dice al
arrancar, y `config.json` lo responde en caliente:

```bash
curl http://localhost:3000/config.json
```

Si devuelve `{}`, no hay nada sobrescrito y manda lo compilado.

**Un 401 en la sincronización y el resto funcionando** era el síntoma de que las
llamadas con `fetch()` salían sin token. Está resuelto con `ApiFetchService`; si
reaparece, mirar si alguna llamada nueva usa `fetch` a secas.

**«Usuario o contraseña incorrectos» con credenciales buenas** apunta a que se
está hablando con el servidor equivocado: el mismo usuario no existe en todos los
despliegues.

**Entra pero no descarga nada.** Sesión viva y catálogos vacíos suele ser un
`platform`/`deviceid` que el backend no reconoce como equipo dado de alta. La
alta ocurre en el arranque de la sincronización, no en el login.

---

## Archivos relacionados

| Archivo | Qué hace |
|---|---|
| `core/services/auth.service.ts` | Login, offline, adopción desde el teléfono, logout |
| `core/services/api.service.ts` | URL base, timeout, traducción de errores |
| `core/services/api-fetch.service.ts` | Lo mismo para las llamadas con `fetch` |
| `core/interceptors/auth.interceptor.ts` | Pone `x-token` en `HttpClient` |
| `core/services/session-end.service.ts` | Un solo sitio decide cerrar |
| `core/services/sessions.api.ts` | Sesiones abiertas, cierre remoto y `verify()` |
| `core/config/runtime-config.ts` | Lee `config.json` antes de arrancar |
| `core/repositories/user.repository.ts` | Cuentas guardadas y la invariante de sesión activa |
| `server.js` | Genera `config.json` desde las variables de entorno |

---

## Cabo suelto

`AuthService.refreshToken()` existe —renueva el token con las credenciales
guardadas llamando otra vez a `/loginTemp`— pero **no lo llama nadie**. Está
escrito para el caso de un 401 por token caducado a mitad de una tarea; hoy ese
401 termina en `SessionEndService` y en el login. Reengancharlo es una decisión
pendiente, no un olvido del que no quede constancia.
