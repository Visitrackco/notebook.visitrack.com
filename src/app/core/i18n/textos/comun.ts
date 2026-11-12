/** Textos que se repiten en toda la aplicación. */
export const textosComun = {
  'comun.aceptar': ['Aceptar', 'OK'],
  'comun.cancelar': ['Cancelar', 'Cancel'],
  'comun.guardar': ['Guardar', 'Save'],
  'comun.cerrar': ['Cerrar', 'Close'],
  'comun.volver': ['Volver', 'Back'],
  'comun.eliminar': ['Eliminar', 'Delete'],
  'comun.editar': ['Editar', 'Edit'],
  'comun.buscar': ['Buscar', 'Search'],
  'comun.reintentar': ['Reintentar', 'Retry'],
  'comun.continuar': ['Continuar', 'Continue'],
  'comun.si': ['Sí', 'Yes'],
  'comun.no': ['No', 'No'],
  'comun.enLinea': ['En línea', 'Online'],
  'comun.sinConexion': ['Sin conexión', 'Offline'],
  'comun.cargando': ['Cargando…', 'Loading…'],
  'comun.idioma': ['Idioma', 'Language'],
  'comun.ver': ['Ver', 'Show'],
  'comun.ocultar': ['Ocultar', 'Hide'],
  'comun.cerrarAviso': ['Cerrar aviso', 'Dismiss'],
  'comun.volverArriba': ['Volver arriba', 'Back to top'],

  // ── Retiro de actividades (RetentionPolicyService) ────────────────────────
  'ret.minuto': ['minuto', 'minute'],
  'ret.minutos': ['minutos', 'minutes'],
  'ret.hora': ['hora', 'hour'],
  'ret.horas': ['horas', 'hours'],
  'ret.dia': ['día', 'day'],
  'ret.dias': ['días', 'days'],
  'ret.proxima': ['se retirará en la próxima limpieza', 'will be removed at the next cleanup'],
  'ret.menosMin': ['se retira en menos de un minuto', 'removed in less than a minute'],
  'ret.enMin': ['se retira en {n} min', 'removed in {n} min'],
  'ret.enHora': ['se retira en 1 hora', 'removed in 1 hour'],
  'ret.enHoras': ['se retira en {n} horas', 'removed in {n} hours'],
  'ret.manana': ['se retira mañana', 'removed tomorrow'],
  'ret.enDias': ['se retira en {n} días', 'removed in {n} days'],

  // ── Ubicación (GeolocationService) ────────────────────────────────────────
  'gps.buena': ['Precisión buena', 'Good accuracy'],
  'gps.aceptable': ['Precisión aceptable', 'Fair accuracy'],
  'gps.baja': ['Precisión baja', 'Low accuracy'],
  'gps.noSoporta': ['Este navegador no permite obtener la ubicación.', "This browser can't get your location."],
  'gps.https': [
    'La ubicación solo funciona sobre una conexión segura (HTTPS).',
    'Location only works over a secure connection (HTTPS).',
  ],
  'gps.sinPermiso': ['No se concedió el permiso de ubicación.', 'Location permission was not granted.'],
  'gps.noDetermina': ['No se pudo determinar la ubicación.', 'Could not determine the location.'],
  'gps.tiempo': ['Se agotó el tiempo esperando la señal.', 'Timed out waiting for a signal.'],
  'gps.error': ['Error al leer la ubicación.', 'Error reading the location.'],

  // ── Archivos adjuntos (file-policy) ───────────────────────────────────────
  'archivo.noAdmitido': [
    'Los archivos «.{ext}» no se admiten. Solo se pueden adjuntar imágenes, PDF y documentos de Office.',
    '“.{ext}” files are not allowed. Only images, PDFs and Office documents can be attached.',
  ],
  'archivo.muyGrande': [
    'El archivo pesa {peso} y el máximo son 100 MB.',
    'The file is {peso} and the maximum is 100 MB.',
  ],

  // ── Cámara (compartido por fotos y escáner) ───────────────────────────────
  'cam.https': [
    'La cámara solo funciona en una conexión segura (HTTPS). Abre Visitrack desde su dirección https:// y vuelve a intentarlo.',
    'The camera only works over a secure connection (HTTPS). Open Visitrack from its https:// address and try again.',
  ],
  'cam.noPermite': ['Este navegador no permite usar la cámara.', "This browser doesn't allow camera use."],
  'cam.sinPermiso': [
    'No se concedió el permiso de cámara. Habilítalo desde el icono de la barra de direcciones y vuelve a intentarlo.',
    'Camera permission was not granted. Enable it from the icon in the address bar and try again.',
  ],
  'cam.noHay': ['No se encontró ninguna cámara en este dispositivo.', 'No camera was found on this device.'],
  'cam.ocupada': [
    'La cámara está siendo usada por otra aplicación. Ciérrala e inténtalo de nuevo.',
    'The camera is being used by another app. Close it and try again.',
  ],
  'cam.bloqueada': [
    'El navegador bloqueó la cámara en esta página. Comprueba que esté en HTTPS y que el sitio tenga permiso.',
    'The browser blocked the camera on this page. Check that it is on HTTPS and the site has permission.',
  ],
  'cam.noAbre': [
    'No se pudo abrir la cámara. Comprueba que la página esté en HTTPS.',
    'Could not open the camera. Check that the page is on HTTPS.',
  ],

  // ── Escáner de códigos ────────────────────────────────────────────────────
  'esc.cerrarEsc': ['Cerrar (Esc)', 'Close (Esc)'],
  'esc.camara': ['Cámara', 'Camera'],
  'esc.cambiarCamara': ['Cambiar de cámara', 'Switch camera'],
  'esc.apagarLinterna': ['Apagar la linterna', 'Turn off flashlight'],
  'esc.encenderLinterna': ['Encender la linterna', 'Turn on flashlight'],
  'esc.aManoCodigo': ['Escribir el código a mano', 'Type the code manually'],
  'esc.aMano': ['Escribir a mano', 'Type manually'],
  'esc.abriendo': ['Abriendo la cámara…', 'Opening the camera…'],
  'esc.tipo': ['Tipo de código', 'Code type'],
  'esc.qr': ['Código QR', 'QR code'],
  'esc.barras': ['Código de barras', 'Barcode'],
  'esc.leido': ['Código leído', 'Code read'],
  'esc.indicaBarras': [
    'Acerca la cámara hasta que el código de barras llene el recuadro de lado a lado',
    'Move the camera closer until the barcode fills the box from side to side',
  ],
  'esc.indicaQr': ['Centra el código QR dentro del recuadro', 'Center the QR code inside the box'],
  'esc.sinLector': [
    'No se pudo cargar el lector de códigos en este navegador. Si estás sin conexión, conéctate un momento y vuelve a intentarlo.',
    "The code reader couldn't load in this browser. If you're offline, connect briefly and try again.",
  ],

  // ── Vista previa de PDF ───────────────────────────────────────────────────
  'pdf.sinConexion': [
    'El PDF lo arma el servidor en el momento. Vuelve a intentarlo cuando tengas señal.',
    'The server builds the PDF on the fly. Try again when you have signal.',
  ],
  'pdf.generando': ['Generando el documento…', 'Generating the document…'],
  'pdf.tarda': ['Suele tardar unos segundos', 'Usually takes a few seconds'],
  'pdf.descargando': ['Descargando…', 'Downloading…'],
  'pdf.descargar': ['Descargar', 'Download'],
  'pdf.abrirAparte': ['Abrir aparte', 'Open separately'],
} as const;
