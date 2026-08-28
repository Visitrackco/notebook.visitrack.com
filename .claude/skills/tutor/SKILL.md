---
name: tutor
description: Construye recorridos guiados con foco sobre la propia pantalla (modelo del tour de Geocercas en Module). Úsalo cuando pidan un tutor, un tutorial, una guía, un onboarding o "explicar cómo funciona" una pantalla.
---

# Tutor: recorridos guiados sobre la pantalla

Un tutor **no es un manual**. Es un recorrido que oscurece la pantalla, ilumina
un elemento a la vez y explica al lado qué hace y **cuándo usarlo**.

La alternativa habitual —una pantalla de ayuda aparte— nadie la lee, y menos
cuando la duda aparece justo delante de la pantalla que hay que usar.

## De dónde sale el modelo

Del recorrido de **Geocercas en Module**
(`CloudGoldFront/src/app/presentation/shared/tour/tour.component.ts`). Ese es el
original; lo demás son puertos a otras plataformas. Antes de inventar nada,
mirarlo.

Implementaciones vivas:

| Proyecto | Componente | Se usa en |
|---|---|---|
| Module (Angular) | `shared/tour/tour.component.ts` | Geocercas |
| Móvil (Flutter) | `lib/widgets/Utilities/TourOverlay.dart` | Sincronización |
| Web | *(sin puerto todavía; ver abajo)* | — |

## El contrato de un paso

Idéntico en las tres plataformas. Cambia cómo se apunta al elemento, no la idea.

| Campo | Angular | Flutter |
|---|---|---|
| A qué apunta | `selector: string` (CSS) | `clave: GlobalKey` |
| Título | `titulo` | `titulo` |
| Explicación | `texto` | `texto` |
| Preparar la pantalla | `antes?: () => void` | `antes?: Future<void> Function()` |

## Las reglas que hacen que funcione

Estas no son detalles de implementación: son las decisiones que separan un
tutor útil de uno que estorba.

1. **Un paso sin su elemento en pantalla se salta.** Una sección plegada, un
   botón que solo sale con datos. Iluminar la nada es peor que no explicar.

2. **Cada paso dice *cuándo* usar eso, no solo qué hace.** «Descarga los datos»
   no ayuda a nadie; «úsalo la primera vez y cada vez que te cambien zonas» sí.
   Es lo que casi ninguna ayuda dice y lo único que hace falta para decidir.

3. **El orden es el del trabajo real**, no el del layout. En Sync: preparar →
   sincronizar → comparar → diagnosticar. Quien abre la pantalla no necesita
   saber qué hace cada botón, necesita saber cuál pulsar primero.

4. **Se puede saltar en cualquier momento.** Un tutor del que no se sale es un
   muro.

5. **Se ofrece una vez y se puede reabrir siempre.** La primera vez se propone;
   después vive en un botón visible (icono de birrete en la barra). Nunca se
   impone dos veces.

6. **La tarjeta se coloca donde no tape el foco**: debajo si cabe, encima si no.

7. **Tocar fuera avanza.** Es lo que la gente intenta antes de buscar el botón.

## Cómo usarlo

### Flutter

```dart
final _anclaBoton = GlobalKey();

// En el widget:
FilledButton(key: _anclaBoton, ...)

// Para abrirlo:
TourOverlay.mostrar(context, pasos: [
  PasoTour(
    clave: _anclaBoton,
    titulo: '2. Sincroniza',
    texto: 'Qué hace.\n\nY cuándo usarlo.',
  ),
]);
```

Las `GlobalKey` van **en el State de la pantalla**, no dentro de los
sub-widgets: el recorrido las mide sobre esa pantalla, y una clave dentro de un
widget que se reconstruye pierde el contexto entre pasos.

Si el sub-widget no acepta `key`, añádele `super.key` al constructor antes de
envolverlo en un `KeyedSubtree`: es menos invasivo que tocar el árbol.

### Angular

```ts
readonly pasos: PasoTour[] = [
  { selector: '.geo-crear', titulo: '...', texto: '...' },
];
tourAbierto = signal(false);
```

```html
<app-tour [pasos]="pasos" [abierto]="tourAbierto()" (cerrado)="cerrarTour()" />
```

Se recuerda en `localStorage` que ya se vio, con `try/catch`: un navegador sin
almacenamiento debe poder cerrarlo igual.

## Si hace falta portarlo al web (WebVisitrack)

El componente de Module es Angular y el web también, así que se copia casi tal
cual: `tour.component.ts` + su CSS. Dos ajustes:

- Los tokens de color son distintos (`--vt-*` en el web, `--accent` y
  compañía en Module).
- El web es offline-first: si un paso depende de datos del servidor, hay que
  comprobar `ConnectivityService` en su `antes`.

## Qué NO hacer

- **No lo abras solo al entrar.** Aparecer encima de una pantalla recién abierta
  sin que nadie lo pida es lo contrario de enseñar. Ofrécelo la primera vez que
  la persona vaya a *hacer* algo.
- **No lo conviertas en una lista de nueve tarjetas.** Eso es un manual. Si no
  ilumina la pantalla real, no es un tutor.
- **No dupliques la referencia.** Si la pantalla ya tiene una ayuda con el
  detalle de cada botón, el tutor no la repite: la referencia se consulta, el
  tutor se recorre. Que convivan es correcto; que digan lo mismo, no.
