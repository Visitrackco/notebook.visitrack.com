/**
 * Definición del menú principal.
 *
 * Está aquí y no repartido por las plantillas para que exista **una sola**
 * fuente de verdad: la barra lateral, la navegación móvil y las migas de pan
 * leen de esta lista, así que agregar una sección es tocar un solo archivo.
 */

export interface NavItem {
  /** Identificador estable. Coincide con el `ModuleKey` de los permisos. */
  key: string;
  /** Texto visible. */
  label: string;
  /** Ruta destino. */
  route: string;
  /** Nombre del icono, resuelto por `IconComponent`. */
  icon: string;
  /** Descripción breve para el tooltip cuando la barra está colapsada. */
  description?: string;
  /**
   * Permiso necesario para verla. Si se omite, la sección es visible para
   * cualquier usuario autenticado.
   */
  permission?: string;
  /** true si todavía no está implementada: se muestra deshabilitada. */
  comingSoon?: boolean;
}

/** Grupo de secciones bajo un mismo encabezado. */
export interface NavSection {
  /** Título del grupo. Vacío para el primero, que no lleva encabezado. */
  title: string;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    title: '',
    items: [
      {
        key: 'home',
        label: 'Inicio',
        route: '/inicio',
        icon: 'home',
        description: 'Resumen de tu actividad',
      },
    ],
  },
  {
    title: 'Operación',
    items: [
      {
        key: 'dispatches',
        label: 'Mis consignas',
        route: '/consignas',
        icon: 'send',
        description: 'El trabajo que te asignaron',
      },
      {
        key: 'forms',
        label: 'Formularios',
        route: '/formularios',
        icon: 'clipboard',
        description: 'Diligencia y consulta actividades',
      },
      {
        key: 'locations',
        label: 'Ubicaciones',
        route: '/ubicaciones',
        icon: 'map-pin',
        description: 'Sedes, sus activos y sus actividades',
      },
    ],
  },
  {
    title: 'Datos',
    items: [
      {
        key: 'sync',
        label: 'Sincronización',
        route: '/sincronizacion',
        icon: 'refresh',
        description: 'Estado de tus datos locales',
      },
      {
        key: 'drafts',
        label: 'Borradores',
        route: '/borradores',
        icon: 'pen',
        description: 'Actividades a medias, antes de que caduquen',
      },
      {
        key: 'pending',
        label: 'Pendientes',
        route: '/pendientes',
        icon: 'cloud-upload',
        description: 'Actividades por enviar a Visitrack',
      },
      {
        key: 'link',
        label: 'Vincular teléfono',
        route: '/vincular',
        icon: 'send',
        description: 'Trae aquí lo que tienes en el teléfono',
      },
      {
        key: 'entities',
        label: 'Entidades por subir',
        route: '/entidades',
        icon: 'map-pin',
        description: 'Ubicaciones, activos e ítems creados aquí',
      },
      {
        key: 'files',
        label: 'Archivos',
        route: '/archivos',
        icon: 'image',
        description: 'Fotos y documentos capturados',
      },
    ],
  },
  {
    title: 'Cuenta',
    items: [
      {
        key: 'profile',
        label: 'Mi perfil',
        route: '/perfil',
        icon: 'user',
        description: 'Datos personales y preferencias',
      },
    ],
  },
];

/** Todas las secciones en una sola lista, sin agrupar. */
export const ALL_NAV_ITEMS: NavItem[] = NAVIGATION.flatMap((section) => section.items);

/** Busca la sección que corresponde a una ruta. */
export function findNavItem(route: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((item) => route.startsWith(item.route));
}
