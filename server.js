/**
 * Servidor estático para el build de producción.
 *
 * ## Por qué existe
 *
 * `ng serve` es el servidor de desarrollo: recompila, inyecta el recargador en
 * caliente y no es lo que se pone delante de nadie. Para probar el resultado
 * real —el mismo paquete que se subiría— hace falta servir `dist/` tal cual.
 *
 * Solo usa módulos de Node: no agrega dependencias al proyecto ni un
 * `package.json` aparte que luego haya que mantener.
 *
 * ## Rutas y recarga
 *
 * La aplicación usa `withHashLocation()` (ver `app.config.ts`), así que la ruta
 * viaja en el fragmento —`/#/perfil`— y el navegador **nunca la envía**: al
 * servidor siempre le llega `GET /`. Por eso recargar en cualquier pantalla
 * funciona sin configuración especial, que es justo lo que se buscaba.
 *
 * Aun así abajo hay un respaldo que devuelve `index.html` ante cualquier ruta
 * desconocida. No hace falta hoy, pero cuesta tres líneas y cubre el caso de
 * que alguien quite el hash más adelante, o de un enlace viejo sin `#`.
 *
 * ## La dirección del backend no está compilada
 *
 * `GET /config.json` se responde desde las variables de entorno, y la
 * aplicación lo lee al arrancar (ver `core/config/runtime-config.ts`). Cambiar
 * de servidor es cambiar la variable: el mismo `dist/` sirve para producción,
 * preproducción y una máquina local.
 *
 * ## Cómo se corre
 *
 * ```bash
 * npm run build
 * npm run serve:dist        # http://localhost:3000
 * PORT=8080 node server.js  # otro puerto
 *
 * API_URL=https://otro.servidor.com npm run serve:dist
 * ```
 *
 * O en un archivo `.env` junto a este, que se lee **en cada petición**: se
 * edita, se recarga la página y ya apunta a otro sitio, sin reiniciar nada.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT) || 3000;

/** La carpeta que genera `npm run build`. */
const ROOT = path.join(__dirname, 'dist', 'WebVisitrack', 'browser');

const INDEX = path.join(ROOT, 'index.html');

/**
 * Tipo de contenido por extensión.
 *
 * Sin esto el navegador recibe los `.js` como texto plano y se niega a
 * ejecutarlos: la página carga en blanco y el error que da no menciona el
 * tipo, así que cuesta más de lo que debería dar con la causa.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

/** Lo que vale la pena comprimir: texto. Una imagen ya viene comprimida. */
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg)/;

/**
 * El build pone un hash en el nombre de cada archivo (`outputHashing: 'all'`),
 * así que un `main-A1B2C3.js` nunca cambia de contenido: se puede guardar en
 * caché para siempre. `index.html` no lleva hash y es quien apunta a los demás,
 * así que ese sí debe pedirse cada vez — si se cachea, el navegador sigue
 * cargando la versión anterior después de desplegar.
 */
const HASHED = /-[A-Z0-9]{8,}\.(js|css)$/i;

/**
 * Qué variable de entorno alimenta cada ajuste, y cómo se lee su valor.
 *
 * Solo van las que tiene sentido cambiar sin recompilar. `production` y
 * `appVersion` describen el paquete, no dónde está desplegado: si vinieran de
 * fuera podrían mentir sobre lo que se está ejecutando.
 */
const CONFIG_VARS = {
  API_URL: ['apiUrl', String],
  PLATFORM_URL: ['platformUrl', String],
  LOCAL_API_URL: ['localApiUrl', String],
  BINARIES_URL: ['binariesUrl', String],
  USE_LOCAL_API: ['useLocalApi', (v) => v === 'true' || v === '1'],
  REQUEST_TIMEOUT: ['requestTimeout', Number],
  SYNC_INTERVAL_MINUTES: ['syncIntervalMinutes', Number],
};

const ENV_FILE = path.join(__dirname, '.env');

/**
 * Lee el `.env` de al lado, si existe.
 *
 * Formato mínimo a propósito —`CLAVE=valor`, `#` para comentarios— porque lo
 * que hace falta es cambiar una dirección, no un lenguaje de configuración. Sin
 * dependencias: agregar `dotenv` para esto sería traer un paquete al proyecto
 * entero por catorce líneas.
 *
 * Se lee **en cada petición** y no una vez al arrancar. Es un archivo diminuto y
 * solo lo pide `config.json`, y a cambio cambiar de servidor no exige reiniciar
 * el proceso — que es justo lo que uno no quiere hacer cuando hay gente
 * trabajando encima.
 */
function readEnvFile() {
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    return {};
  }

  const values = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Comillas opcionales, para valores con espacios.
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);

    values[key] = value;
  }

  return values;
}

/**
 * El `config.json` que lee la aplicación al arrancar.
 *
 * Solo lleva **lo que esté definido**. Una clave ausente deja el valor que trae
 * compilado; mandarlas todas siempre obligaría a repetir aquí la configuración
 * entera para cambiar una sola dirección.
 *
 * El entorno real gana sobre el `.env`, que es lo que se espera: si alguien
 * exporta `API_URL` al lanzar el proceso, es porque quiere esa y no otra.
 */
function buildConfig() {
  const file = readEnvFile();
  const config = {};

  for (const [name, [key, parse]] of Object.entries(CONFIG_VARS)) {
    const raw = process.env[name] ?? file[name];
    if (raw === undefined || raw === '') continue;

    const value = parse(raw);

    // Un número mal escrito se ignora: `REQUEST_TIMEOUT=treinta` como NaN haría
    // que toda petición venciera al instante, sin nada que apunte a la causa.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      console.warn(`Se ignora ${name}: "${raw}" no es un número`);
      continue;
    }

    config[key] = value;
  }

  return config;
}

/**
 * Traduce la dirección pedida a un archivo dentro de `ROOT`.
 *
 * Devuelve `null` si el resultado se sale de la carpeta. Sin esa comprobación,
 * un `GET /../../..%2Fetc%2Fpasswd` leería fuera del proyecto: es local y de
 * desarrollo, pero también es una línea.
 */
function resolve(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return null;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.join(ROOT, path.normalize(pathname));
  return file === ROOT || file.startsWith(ROOT + path.sep) ? file : null;
}

/** Envía un archivo, comprimido si el navegador lo acepta y compensa. */
function send(req, res, file, status = 200) {
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

  const cache = HASHED.test(file)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  const headers = { 'Content-Type': type, 'Cache-Control': cache };

  const accepts = String(req.headers['accept-encoding'] ?? '').includes('gzip');
  const gzip = accepts && COMPRESSIBLE.test(type);

  if (gzip) headers['Content-Encoding'] = 'gzip';
  headers['Vary'] = 'Accept-Encoding';

  res.writeHead(status, headers);

  // HEAD: las cabeceras ya salieron, el cuerpo no va.
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());

  if (gzip) stream.pipe(zlib.createGzip()).pipe(res);
  else stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Método no permitido');
    return;
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  /**
   * Se responde antes de mirar el disco: este archivo no existe como archivo.
   *
   * `no-store` es obligatorio. Cacheado, cambiar la variable no tendría efecto
   * hasta que al navegador le apeteciera volver a pedirlo — y el síntoma sería
   * «cambié la dirección y sigue yendo a la anterior», que se persigue durante
   * un buen rato antes de sospechar de la caché.
   */
  if (pathname === '/config.json') {
    const body = JSON.stringify(buildConfig());

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });

    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  const file = resolve(req.url);

  if (!file) {
    res.writeHead(403).end('Prohibido');
    return;
  }

  try {
    const stat = await fsp.stat(file);
    if (stat.isFile()) return send(req, res, file);
  } catch {
    // No existe. Puede ser una ruta de la aplicación: sigue al respaldo.
  }

  /**
   * Respaldo de aplicación de una sola página.
   *
   * Un archivo con extensión que no está —una imagen borrada, un `.js` que ya
   * no se genera— **no** es una ruta: devolver el index ahí escondería el fallo
   * detrás de un HTML que el navegador no sabe interpretar, y el error que
   * saldría no diría nada del archivo que falta.
   */
  if (path.extname(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
    return;
  }

  send(req, res, INDEX);
});

if (!fs.existsSync(INDEX)) {
  console.error(`No hay build en ${ROOT}\nCompila primero con: npm run build`);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`WebVisitrack en http://localhost:${PORT}`);
  console.log(`Sirviendo ${ROOT}`);

  /**
   * Se dice a qué backend apunta al arrancar. Es la pregunta que se hace
   * siempre que algo no cuadra, y sin esta línea la respuesta está dentro de un
   * `.js` con hash en el nombre.
   */
  const config = buildConfig();

  console.log(
    config.apiUrl
      ? `API: ${config.apiUrl}`
      : 'API: la compilada (define API_URL o pon un .env para cambiarla)',
  );
});

/** Ctrl+C: cerrar el servidor en vez de dejar el puerto tomado. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
