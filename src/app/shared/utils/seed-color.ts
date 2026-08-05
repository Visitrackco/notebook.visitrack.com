/**
 * Identidad de color estable para cada formulario.
 *
 * Cada formulario recibe siempre la misma pareja de colores, sin guardarla en
 * ninguna parte: se deriva de su GUID. Así se reconoce de un vistazo en el
 * listado y ese reconocimiento sobrevive a recargas y a cambios de equipo.
 *
 * ## Por qué una paleta curada y no color generado
 *
 * Generar el tono con aritmética —`hue * ángulo áureo`, que es lo que hace la
 * app móvil— reparte bien los colores pero produce muchos apagados: los verdes
 * oliva y los mostazas caen en el rango sin que nadie los haya elegido. Una
 * lista curada garantiza que **cualquier** formulario salga con una combinación
 * que alguien aprobó, y sigue siendo determinista.
 *
 * Diez parejas bastan: pasado ese número los tonos empiezan a parecerse entre
 * sí y se pierde justo lo que se busca, que es distinguirlos de un vistazo.
 */

/** Pareja de colores de una ficha. */
export interface SeedPalette {
  /** Color base. Manda en el acento y en el texto sobre superficie clara. */
  from: string;
  /** Color de cierre del degradado. */
  to: string;
  /** Fondo muy diluido, para superficies suaves. */
  tint: string;
  /** Nombre, útil para depurar. */
  name: string;
}

/**
 * Paletas disponibles.
 *
 * Todas comparten luminosidad y saturación parecidas, así que ninguna ficha
 * pesa visualmente más que otra en la cuadrícula.
 */
export const SEED_PALETTES: readonly SeedPalette[] = [
  { name: 'violeta', from: '#7c3aed', to: '#a855f7', tint: '#f5f3ff' },
  { name: 'índigo', from: '#4f46e5', to: '#6366f1', tint: '#eef2ff' },
  { name: 'azul', from: '#2563eb', to: '#3b82f6', tint: '#eff6ff' },
  { name: 'cian', from: '#0891b2', to: '#06b6d4', tint: '#ecfeff' },
  { name: 'esmeralda', from: '#059669', to: '#10b981', tint: '#ecfdf5' },
  { name: 'lima', from: '#4d7c0f', to: '#84cc16', tint: '#f7fee7' },
  { name: 'ámbar', from: '#d97706', to: '#f59e0b', tint: '#fffbeb' },
  { name: 'naranja', from: '#ea580c', to: '#fb923c', tint: '#fff7ed' },
  { name: 'rosa', from: '#db2777', to: '#f472b6', tint: '#fdf2f8' },
  { name: 'fucsia', from: '#a21caf', to: '#d946ef', tint: '#fdf4ff' },
];

/**
 * Hash de 32 bits (variante de djb2).
 *
 * `>>> 0` fuerza el resultado a entero sin signo: en JavaScript los
 * desplazamientos trabajan con enteros de 32 bits **con** signo, y sin eso la
 * mitad de las entradas daría un valor negativo.
 */
function hashCode(value: string): number {
  let hash = 5381;

  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }

  return hash;
}

/** Paleta que corresponde a [seed]. Siempre la misma para la misma entrada. */
export function seedPalette(seed: string): SeedPalette {
  return SEED_PALETTES[hashCode(seed) % SEED_PALETTES.length];
}

/** Degradado listo para usar como fondo. */
export function seedGradient(seed: string): string {
  const palette = seedPalette(seed);
  return `linear-gradient(135deg, ${palette.from} 0%, ${palette.to} 100%)`;
}
