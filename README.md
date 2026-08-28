# WebVisitrack

Versión web de VT Mobile Form. Angular 21, **offline-first**: funciona sin
conexión y sincroniza cuando vuelve el internet.

## Cómo ejecutarlo

```bash
npm start        # desarrollo en http://localhost:4200
npm run build    # compilación de producción
```

## Por qué offline-first

La aplicación se usa en campo, donde la señal es intermitente o no existe.
Exigir conexión la volvería inútil justo cuando más se necesita. Por eso:

- Los datos viven en **IndexedDB**, en el navegador.
- Lo que el usuario hace se guarda localmente y se encola para subir después.
- La interfaz dice en todo momento si hay conexión, para que nadie asuma que su
  trabajo ya llegó al servidor cuando no es así.

## Estructura

```
src/app/
├── core/                    Todo lo que no es pantalla
│   ├── config/              Menú, reglas por compañía, configuración en ejecución
│   ├── database/            Esquema de IndexedDB y acceso de bajo nivel
│   ├── forms/               Motor de diligenciamiento
│   ├── guards/              Protección de rutas
│   ├── interceptors/        Token en las peticiones
│   ├── models/              Tipos del dominio
│   ├── repositories/        Acceso a datos (patrón repositorio)
│   ├── rules/               Lógica propia de una compañía, aislada
│   ├── services/            Autenticación, HTTP, conectividad, dispositivo
│   └── sync/                Subida de actividades, archivos y entidades
├── features/                Una carpeta por pantalla
│   ├── activities/          Actividades: listado, selectores, detalle y formulario
│   ├── auth/                Login y la descarga inicial
│   ├── binaries/            Archivos guardados en el navegador
│   ├── dispatches/          Consignas: el trabajo que llega asignado
│   ├── drafts/              Lo que se abrió y nunca se guardó
│   ├── entities/            Ubicaciones y activos creados aquí, por subir
│   ├── forms/               Listado de formularios
│   ├── history/             Historial de una ubicación o un activo
│   ├── home/
│   ├── link/                Traspaso desde el teléfono
│   ├── locations/           Catálogo de sedes y equipos
│   ├── pending/             Actividades esperando salir
│   ├── profile/
│   └── sync/
├── layout/shell/            Barra lateral + cabecera
└── shared/components/       Componentes reutilizables
```

Las rutas van **en español**: la URL es parte de la interfaz — el usuario la ve,
la comparte y a veces la escribe.

### Regla de dependencias

`features` → `core` → nada.

Un componente **nunca** toca `DatabaseService` directamente: pide un
repositorio. Eso mantiene el conocimiento de *cómo se consulta* cada entidad en
un solo lugar, en vez de repartido por las plantillas.

## Capa de datos

### Esquema

`core/database/schema.ts` define los object stores. Conserva los **mismos
nombres de tabla y de campo** que el SQLite de la app móvil, para que ambos
clientes hablen igual con el backend y los datos sean comparables entre
plataformas sin traducir nada.

Para cambiar el esquema:

1. Subir `DB_VERSION`.
2. Agregar el store o índice en `DB_SCHEMA`.
3. Nunca bajar la versión.

La migración es incremental: agregar un índice no borra datos.

### Diferencias con SQLite que conviene tener presentes

| SQLite (móvil) | IndexedDB (web) |
|---|---|
| Columnas tipadas | Guarda objetos completos; solo se declaran llaves e índices |
| `JOIN` | No existe: se combina en el repositorio |
| `AUTOINCREMENT` implícito | Se declara con `autoIncrement` |
| Archivos en disco, ruta en la tabla | El binario va como `Blob` en `BinariesData` |

### Repositorios

`BaseRepository<T>` aporta lectura, escritura, consultas con índice y
paginación. Cada entidad hereda y agrega lo suyo:

```ts
@Injectable({ providedIn: 'root' })
export class SurveyRepository extends BaseRepository<Survey> {
  protected readonly storeName = 'Surveys';

  findByUser(userId: number) {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (s) => s.IsDeleted !== 1,
    });
  }
}
```

`query()` recorre con cursor y corta al alcanzar el `limit`. Con `getAll()` el
navegador materializa el store entero antes de filtrar, y en `ListsDet` —que
puede tener decenas de miles de ítems— eso congela la pestaña.

## Sesión

`AuthService` autentica contra `GET /loginTemp` y guarda la cuenta localmente.

**Entrada sin conexión:** si el servidor no responde y esa cuenta ya inició
sesión antes en este navegador con las mismas credenciales, se abre la sesión
con los datos locales. Sin eso, la aplicación sería inservible en campo.

Se conservan varias cuentas por navegador para alternar sin volver a escribir
credenciales. Solo una tiene `Session = '1'`, invariante que garantiza
`UserRepository`.

> **Nota de seguridad.** Para validar el acceso offline hay que conservar la
> credencial, igual que hace la app móvil. Está en IndexedDB, aislada por origen.
> Si se quiere endurecer, el camino es guardar un hash con `crypto.subtle` y
> comparar contra él. Queda documentado para que sea una decisión explícita.

## Preferencias: dispositivo vs. usuario

`SettingsRepository` distingue dos alcances:

- **Dispositivo** (`UserID` vacío): tamaño de texto, tema. Compartido.
- **Usuario**: cualquier preferencia que cambie el comportamiento de los datos.

La distinción no es teórica. En la app móvil los ajustes eran globales y eso
produjo un problema real: quien desactivaba la opción de guardar borradores se
la imponía a cualquier otra persona que entrara después en ese equipo, y podía
hacerle perder trabajo sin haberlo pedido nunca.

## Conectividad

`navigator.onLine` no basta: devuelve `true` con un wifi sin salida a internet,
un portal cautivo o una VPN caída — justo los casos que importan.
`ConnectivityService` combina esa señal con si el backend respondió realmente en
el último intento.

Un 401 o un 400 **no** marcan "sin conexión": el servidor está vivo y respondió.
Solo los fallos de transporte cuentan.

## Actividades

Abrir un formulario no lleva directo a las preguntas. Igual que en la app
móvil, primero se ven **sus actividades** —lo que hay a medias, lo pendiente de
subir— y desde ahí se decide si crear una nueva o retomar una empezada.

### El flujo de apertura

Un formulario puede exigir ubicación, activo, o ambos antes de dejarse
diligenciar. Esa cadena la resuelve una única función,
`resolveNextStep(requirements, answer)`, a partir de lo que la actividad **ya
tiene guardado**:

```
crear / abrir
   └─ ¿pide ubicación y no la tiene?  → /formularios/:id/ubicaciones
        └─ ¿pide activo y no lo tiene? → /formularios/:id/activos
             └─ /formularios/:id/actividad/:guid
```

Dos decisiones que conviene entender:

- **Es una función pura, no lógica repartida por los componentes.** En el móvil
  esta decisión está escrita cuatro veces con anidamientos distintos —al crear,
  al abrir con ubicación, al abrir sin ella, al volver del selector— y basta con
  corregir una para que las otras tres queden desalineadas.
- **Cada paso es una ruta y la actividad viaja en la URL.** Con estado en
  memoria harían falta menos rutas, pero recargar la página en mitad del flujo
  —o volver con el botón atrás— dejaría al usuario en una pantalla sin contexto
  y con una actividad ya creada de la que no volvería a saber.

### La actividad existe desde el primer momento

Se crea en IndexedDB **antes** de elegir ubicación, con `eraser = 1`
(borrador). No es un detalle de implementación: es lo que permite que las fotos
y las filas de MasterDetail se cuelguen de algo, y lo que hace que abandonar el
flujo a medias deje algo recuperable en vez de nada.

### Autoguardado

`AutosaveService` agrupa las escrituras con un retardo corto y expone en qué
punto va, para que el indicador de la cabecera lo diga. Un guardado que no se ve
genera la duda de si se guardó, y esa duda hace que la gente repita el trabajo.

Se vacía solo al ocultar la pestaña (`visibilitychange`, `pagehide`) y las
pantallas llaman a `flush()` antes de navegar: el retardo abre una ventana en la
que lo último escrito todavía no está en la base, y es siempre el cambio más
reciente — el que el usuario más recuerda haber hecho.

El botón **Guardar** no escribe en disco (eso ya pasó): marca la actividad como
terminada y lista para subir.

### Borradores

`DraftPolicyService` decide qué pasa con una actividad que se abrió y nunca se
guardó, y es un ajuste **por usuario**:

- **Activados** (por defecto): queda en la lista marcada como borrador y se
  limpia sola pasadas las horas configuradas.
- **Desactivados**: se descarta al salir sin guardar, como un formulario
  clásico.

Solo se descartan las actividades con `eraser = 1` —creadas aquí y nunca
guardadas—. Las que bajan del servidor entran con `eraser = 0`, así que una
actividad asignada desde la plataforma no puede perderse por esta vía.

En el móvil esta preferencia vivía en una tabla global y produjo un problema
real: quien la desactivaba se la aplicaba a cualquier otra cuenta que iniciara
sesión después en el mismo equipo. Aquí va a nombre de la cuenta.

## Diligenciamiento

El motor vive en `core/forms/`. Dos piezas lo sostienen:

- **`form-schema.ts`** — tipos y reglas puras: qué es una página, qué es un
  campo, cuándo está visible y cuándo cuenta como respondido. Los nombres de
  propiedad son los del servidor (`fty`, `lab`, `req`, `sect`) y no se
  renombran: traducir aquí obligaría a destraducir al guardar.
- **`form-engine.ts`** — el estado de una actividad abierta. Es una **clase, no
  un servicio**: con un servicio de raíz habría que acordarse de limpiarlo al
  salir, y la actividad siguiente heredaría los valores de la anterior.

Alrededor, un archivo por cada cosa que un campo puede necesitar y que no es el
motor: de dónde salen los ítems de una lista (`list-source.service.ts`,
`list-search.api.ts`), de dónde salen las filas de una tabla de detalle
(`master-detail-source.service.ts`, `master-detail.ts`), qué se calcula a partir
de otras respuestas (`derived-fields.ts`), qué llega puesto de antemano
(`inherited-defaults.ts`) y los formularios vinculados
(`linked-form.service.ts`).

### Visibilidad condicionada

Un campo con `sect` solo se muestra si esa sección está activa, y las activa la
opción elegida en un campo de selección (`opt[].act_data`). Cada campo activador
mantiene **una** sección: elegir otra opción reemplaza la suya en vez de
acumular.

Al reabrir una actividad, las secciones activas se **deducen de las respuestas
guardadas**. Sin eso, una actividad guardada con una rama abierta se reabriría
con ella cerrada: los campos ya respondidos desaparecerían de la vista.

### Obligatorios

Se exigen al guardar, no al pasar de página: en campo se salta una pregunta para
volver a ella —falta el dato, hay que consultarlo— y bloquear el avance
convierte eso en un callejón sin salida.

Un campo **oculto no se exige**, aunque sea obligatorio: su control no llega a
dibujarse, así que no habría forma de responderlo.

Antes de intentar guardar solo se señalan los campos que el usuario ya tocó.
Teñir de rojo un formulario recién abierto es acusarle de un error que aún no ha
tenido ocasión de cometer.

### Tipos implementados

**Todos.** Texto, texto largo, numérico, fecha, fecha y hora, hora, correo,
teléfono, celular, dirección, selección única, selección múltiple, desplegable,
título, párrafo, hipervínculo, foto, imagen, firma, audio, video, archivo, GPS,
tabla de detalle, suma de detalle, cálculo, diferencia de fechas y formulario
vinculado.

Los seis tipos de archivo comparten un mismo componente: entre una foto y una
firma lo que cambia es **de dónde sale el contenido**, no cómo se guarda ni cómo
se muestra después.

## Estado actual

| Módulo | Estado |
|---|---|
| Base de datos local (29 stores) | Listo |
| Repositorios | Listo |
| Login (con modo offline) | Listo |
| Menú y navegación | Listo |
| Perfil y preferencias | Listo |
| Descarga inicial y sincronización por lotes | Listo |
| Listado de formularios | Listo |
| Actividades: listado, estados, regla de borrado | Listo |
| Flujo de apertura (ubicación → activo → formulario) | Listo |
| Autoguardado y política de borradores | Listo |
| Motor de formularios: páginas, obligatorios, visibilidad condicionada | Listo |
| Todos los tipos de campo, archivos incluidos | Listo |
| MasterDetail, cálculos y formularios vinculados | Listo |
| Subida de actividades, archivos y entidades, con el gate de confirmación | Listo |
| Consignas, borradores, pendientes y archivos como pantallas propias | Listo |
| Catálogo de ubicaciones y activos, con creación y edición | Listo |
| Vinculación con el teléfono | Listo |
| Reglas por compañía (`core/rules/`) | Listo |
| Historial por ubicación o activo | Escrito, **sin probar contra datos reales** |
| MasterDetail como tabla y pegar desde Excel | Propuesta, sin implementar |

### Lo que sigue

1. Probar el historial contra SQL Server con un usuario que tenga zonas de
   trabajo y un activo con actividades de varios formularios. Ver
   `docs/historial-actividades.md`.
2. MasterDetail como tabla editable y pegar un bloque desde Excel. El diseño
   está acordado en `docs/masterdetail-pegar-excel.md`, con su regla de fondo:
   nunca adivinar a qué registro corresponde un nombre.

## Documentación

| Documento | De qué trata |
|---|---|
| `docs/login-y-servidor.md` | A qué servidor apunta y cómo cambiarlo sin recompilar |
| `docs/servicio-login.md` | Contrato de `GET /loginTemp` |
| `docs/historial-actividades.md` | Historial por ubicación o activo, y descargar una actividad |
| `docs/masterdetail-pegar-excel.md` | Propuesta de tabla editable con pegado desde Excel |

El backend es **`cloud-server`** (Node), el mismo que consume la app móvil. No
está en este repositorio.
