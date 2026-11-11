# Butaca Backend

## Estado para integración con frontend

Esta copia incorpora watchlist, progreso y su integración con el Gateway. Los cambios locales requieren revisión, PR y despliegue antes de considerarlos disponibles en el servidor público. La existencia de tablas no implica que sus endpoints estén implementados.

| Función | Estado del código y contrato |
| --- | --- |
| Media: tendencias, búsqueda, populares, géneros y detalles | Implementado. Rutas públicas `/api/v1/media/*`, documentadas abajo. |
| Watchlist | GET `/api/v1/library/watchlist`, PUT/DELETE `/api/v1/library/watchlist/:media_type/:tmdb_id`. JWT requerido, sin campos de usuario en la petición. Cambios locales de esta entrega. |
| Favoritos | GET `/api/v1/library/favorites`, PUT/DELETE `/api/v1/library/favorites/:media_type/:tmdb_id`. JWT requerido, sin campos de usuario en la petición. |
| Progreso | GET `/api/v1/library/progress`, PUT `/api/v1/library/progress/:media_type/:tmdb_id` y PUT/DELETE de episodios. JWT requerido. Cambios locales de esta entrega. |
| Recomendaciones | Implementado. Consume favoritos, watchlist y progreso de Library con el token del usuario. No consume emociones. |
| Análisis de cámara con AWS Rekognition | `POST /api/v1/emotions/analyze`: multipart con `image` y `consent=true`, máximo 2 MiB, sin persistencia y con confirmación requerida. Contrato en [`docs/contrato-emociones.md`](docs/contrato-emociones.md). |
| Historial emocional | `GET /api/v1/emotions/history?period=7d|30d` o `?year=YYYY`, con las recomendaciones guardadas de cada día (`PUT /api/v1/emotions/history/:id/recommendations/:media_type/:tmdb_id`). |

El esquema permite una detección por usuario y día: una nueva detección el mismo día reemplaza la anterior. La zona horaria la envía el frontend (`time_zone`) y los códigos de emociones son los del catálogo `library.moods`. Las decisiones que el equipo aún debe confirmar están al final de [`docs/contrato-emociones.md`](docs/contrato-emociones.md).

El frontend inicia sesión mediante Supabase Auth y envía el access token en `Authorization: Bearer <token>`. No usar API keys como token de usuario. Los proveedores OAuth se habilitan en Supabase, no mediante el Gateway. Las operaciones privadas determinan el usuario a partir del JWT; nunca desde `profile_id` o `user_id` enviados por el cliente.

En el frontend actual, `VITE_API_URL` debe contener solo el origen del Gateway (`http://localhost:8080` en local), porque el cliente agrega `/api/v1/...`. En producción usar el origen HTTPS de Funnel del servidor desplegado. No agregar dos veces el prefijo. Configurar `FRONTEND_ORIGIN` con el origen exacto del frontend para CORS.

Para ampliar el catálogo, consumir `/api/v1/media/popular?media_type=movie&page=1&language=es-MX` o `/api/v1/media/search?query=dune&media_type=movie&page=1&language=es-MX`. Usar `page`, `total_pages` y `total_results` de la respuesta; tendencias solo ofrece la primera página. Una lista vacía no es un error.

El API Gateway recibe las consultas del cliente en el puerto 8080. Media Service consulta TMDB y devuelve películas y series normalizadas. Recommendation Service calcula recomendaciones personales consumiendo Media y Library. Los servicios usan Node.js 24, TypeScript y Express.

## Ejecutar con Docker Compose

Desde la raíz del repositorio, crea una copia local de `.env.example` llamada `.env`. En PowerShell puedes usar `Copy-Item .env.example .env` si todavía no tienes un archivo `.env`.

| Variable | Uso |
| --- | --- |
| `TMDB_READ_ACCESS_TOKEN` | Token de lectura de la API de TMDB. Solo lo recibe Media Service. |
| `FRONTEND_ORIGIN` | Origen permitido por CORS. Por defecto, `http://localhost:5173`. |
| `CACHE_TTL_MS` | Vigencia de las respuestas de TMDB en caché, en milisegundos. Por defecto, 300000. |
| `CACHE_MAX_ENTRIES` | Máximo de entradas en memoria por tipo de consulta. Por defecto, 64. |
| `SUPABASE_URL` | URL del proyecto Supabase; requerida por los servicios privados. |
| `DATABASE_URL` | Conexión PostgreSQL de Library. La migración debe estar aplicada; los perfiles se crean automáticamente. |
| `AWS_REGION` | Región de Rekognition. Solo se inyecta a Library; el SDK usa la cadena estándar de credenciales. |
| `EMOTION_MIN_CONFIDENCE` | Umbral de producto para sugerir una expresión. Por defecto, 30. |
| `EMOTION_ANALYZE_LIMIT` | Análisis permitidos por usuario y ventana. Por defecto, 10 por minuto. |

Con Docker y el complemento Compose disponibles, ejecuta:

```sh
docker compose up --build -d
docker compose ps
curl -i http://127.0.0.1:8080/health/live
curl -i "http://127.0.0.1:8080/api/v1/media/trending?language=es-MX"
```

En Windows PowerShell usa `curl.exe`. Los cuatro servicios de Compose deben aparecer como saludables. La consulta de tendencias con un token válido de TMDB debe responder con HTTP 200 y un objeto con `page` y `results`. Compose no aplica migraciones ni semillas automáticamente. Si las variables están en `library-service/.env`, se puede seleccionar ese archivo con `docker compose --env-file library-service/.env up --build -d`, siempre que contenga también las demás variables requeridas. No dupliques credenciales en archivos diferentes.

Compose publica el Gateway en el loopback del host. Media Service escucha en el puerto 3001 dentro de la red de Compose y necesita salida HTTPS hacia TMDB. Cada contenedor tiene un límite inicial de 192 MiB. Los healthchecks consultan `/health/live` y comprueban el proceso independientemente de TMDB. Para detener este proyecto, ejecuta `docker compose down` desde su raíz.

## Verificar sin consultar la base de datos

```sh
npm ci
npm test
```

Antes de `npm test`, generar el cliente Prisma con el comando documentado en la sección de Library. La generación requiere `DIRECT_URL` configurada, pero no consulta ni modifica la base de datos. Las pruebas normales compilan en modo estricto, levantan los servicios en puertos locales temporales y simulan TMDB por HTTP. Cubren salud, normalización, solicitudes concurrentes, caché, validación de parámetros y recuperación tras errores del proveedor. La prueba opcional de PostgreSQL solo se ejecuta al configurar expresamente sus variables.

## Autenticación del Gateway

Configura `SUPABASE_URL` con la URL del proyecto y `SUPABASE_JWT_AUDIENCE` con `authenticated` (valor predeterminado). Compose pasa ambas variables al Gateway.

El Gateway verifica tokens ES256 usando las claves públicas de `SUPABASE_URL/auth/v1/.well-known/jwks.json`. Comprueba firma, emisor (`SUPABASE_URL/auth/v1`), audiencia, expiración y sujeto. El validador compartido se reutiliza en Recommendation Service, que conserva sus opciones de autenticación existentes.

Las solicitudes a `/api/v1/library` y `/api/v1/recommendations`, incluidas sus subrutas, requieren `Authorization: Bearer <access_token>`. Los endpoints de Media y salud son públicos. El preflight CORS se procesa antes de la autenticación. CORS expone al frontend `Retry-After`, `RateLimit` y `RateLimit-Policy`, para que pueda esperar el plazo indicado tras un 429.

| Respuesta | Significado |
| --- | --- |
| 401 | Token ausente, inválido o expirado. Incluye `WWW-Authenticate: Bearer`. |
| 503 | Autenticación sin configurar o claves públicas temporalmente inaccesibles. |
| 404 con token válido en Library | La ruta solicitada no está implementada; actualmente solo se publican las operaciones de watchlist. |

Las respuestas de los dominios privados incluyen `Cache-Control: private, no-store`. Cada servicio privado también deberá verificar el token y autorizar sus operaciones. La identidad verificada queda disponible internamente en `res.locals.user`.

La prueba `test/gateway-auth.test.mjs` genera claves temporales y cubre los casos de rechazo, aceptación, caché de claves, fallo del proveedor y consultas públicas. La verificación de una sesión real requiere un access token emitido por el proyecto Supabase.

## Endpoints de Media

Todas las rutas usan el prefijo `/api/v1/media`, solo admiten `GET` y rechazan con HTTP 400 los parámetros desconocidos o repetidos. `language` es opcional, con formato `es-MX` o `en-US`; el valor predeterminado es `es-MX`.

### Resumen de película o serie

Los listados devuelven elementos con esta forma. El contenido se identifica por `media_type` + `id` (identificador de TMDB).

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `id` | entero | Identificador de TMDB. |
| `media_type` | `"movie"` o `"tv"` | Tipo de contenido. |
| `title` | texto | Título de la película o nombre de la serie. |
| `poster_path` | texto o `null` | Ruta de la imagen. URL completa: `https://image.tmdb.org/t/p/w500{poster_path}`. |
| `overview` | texto | Sinopsis; puede ser una cadena vacía. |
| `release_date` | texto o `null` | Estreno (`YYYY-MM-DD`); en series, primera emisión. |
| `vote_average` | número o `null` | Calificación promedio de TMDB (0 a 10). |
| `genre_ids` | enteros | Géneros de TMDB. |

Los listados paginados responden `{ page, total_pages, total_results, results }`. `total_pages` nunca supera 500, el máximo que admite TMDB.

### `GET /trending`

Tendencias diarias de películas y series, en el orden de TMDB. Parámetros: `language`. Responde `{ page, results }` con la primera página.

### `GET /search`

| Parámetro | Obligatorio | Valores |
| --- | --- | --- |
| `query` | Sí | Texto de 1 a 100 caracteres. Se recortan los espacios. |
| `media_type` | No | `all` (predeterminado), `movie` o `tv`. |
| `page` | No | Entero de 1 a 500. Predeterminado 1. |
| `language` | No | `es-MX` por defecto. |

```http
GET /api/v1/media/search?query=dune&media_type=all&page=1&language=es-MX
```

Responde un listado paginado. Con `media_type=all` se excluyen las personas, por lo que una página puede tener menos de 20 elementos y `total_results` también cuenta las personas que encontró TMDB. Se omite contenido para adultos.

### `GET /popular`

Contenido popular según TMDB.

| Parámetro | Obligatorio | Valores |
| --- | --- | --- |
| `media_type` | No | `all` (predeterminado), `movie` o `tv`. |
| `page` | No | Entero de 1 a 500. Predeterminado 1. |
| `language` | No | `es-MX` por defecto. |

```http
GET /api/v1/media/popular?media_type=movie&page=1
```

Responde un listado paginado de 20 elementos por página. Con `media_type=all` se combinan la misma página de películas y de series, intercalando una de cada tipo (hasta 40 elementos). `total_pages` es el del catálogo más largo y `total_results` la suma de ambos: cuando un tipo se agota, las páginas siguientes solo contienen el otro, y si un catálogo está vacío se recorre el otro completo. Para mostrar secciones separadas de películas y series, consulta cada tipo por separado.

### `GET /genres`

Catálogo de géneros con nombres en el idioma solicitado.

| Parámetro | Obligatorio | Valores |
| --- | --- | --- |
| `media_type` | No | `all` (predeterminado), `movie` o `tv`. |
| `language` | No | `es-MX` por defecto. |

```json
{
  "genres": [
    { "id": 28, "name": "Acción", "media_types": ["movie"] },
    { "id": 18, "name": "Drama", "media_types": ["movie", "tv"] }
  ]
}
```

Los géneros se ordenan alfabéticamente según el idioma. `media_types` indica en qué catálogos aparece cada identificador; películas y series comparten algunos, como Drama (18). Cada catálogo se conserva 24 horas en caché por tipo e idioma.

### `GET /:media_type/:id`

Detalle de una película (`/movie/550`) o serie (`/tv/1399`). `media_type` debe ser `movie` o `tv` e `id` un entero positivo de TMDB. Parámetros: `language`. Responde 404 con `{"error":"Contenido no encontrado"}` cuando TMDB no tiene ese contenido.

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `id`, `media_type`, `title`, `poster_path`, `overview`, `release_date`, `vote_average` | | Igual que en el resumen. |
| `original_title` | texto | Título en el idioma original. |
| `tagline` | texto o `null` | Frase promocional. |
| `status` | texto o `null` | Estado según TMDB, por ejemplo `Released` o `Returning Series`. |
| `backdrop_path` | texto o `null` | Imagen de fondo. |
| `genres` | `{ id, name }[]` | Géneros con nombre en el idioma solicitado. |
| `vote_count` | entero o `null` | Número de votos. |
| `runtime` | entero o `null` | Duración en minutos; en series, duración típica del episodio. |
| `number_of_seasons`, `number_of_episodes` | entero o `null` | Solo series. |
| `seasons` | `{ season_number, name, episode_count, air_date, poster_path }[]` | Solo series. La temporada 0 suele contener especiales. |

### Caché, tiempos y errores

Media Service guarda cada respuesta en una caché LRU en memoria durante `CACHE_TTL_MS`, con un máximo de `CACHE_MAX_ENTRIES` entradas por tipo de consulta, y comparte las consultas en curso con los mismos parámetros. Espera hasta 4,5 segundos a TMDB. El Gateway limita las rutas de la API a 120 solicitudes por minuto por IP y espera hasta 7 segundos a Media Service. Los errores se devuelven como JSON con el campo `error`.

| HTTP | Significado |
| --- | --- |
| 400 | Parámetro desconocido, repetido o con formato inválido. El mensaje indica cuál. |
| 404 | Ruta desconocida o contenido inexistente. |
| 429 | Límite del Gateway o del proveedor. Se reenvía el plazo de TMDB cuando llega en segundos. |
| 502 | Servicio inaccesible, respuesta inválida o rechazo de las credenciales de TMDB. |
| 504 | Venció el tiempo de espera de una consulta. |

Datos suministrados por [TMDB](https://developer.themoviedb.org/reference/intro/getting-started). Este producto usa la API de TMDB, pero no está respaldado ni certificado por TMDB.

## Library Service: favoritos, watchlist y progreso

Library escucha en `127.0.0.1:3002` por defecto (`BIND_HOST` permite cambiar la interfaz). Implementa favoritos, watchlist, progreso y su integración con Gateway/Compose. Reutiliza el esquema y la migración integrados en el PR #18; no requiere otra migración. No llama a TMDB. En Compose escucha internamente en `0.0.0.0:3002`, sin publicar ese puerto al host.

El Gateway reenvía únicamente las rutas de favoritos, watchlist y progreso documentadas abajo y el JWT verificado. Conserva errores y respuestas DELETE sin cuerpo. Permite preflight CORS para GET, PUT y DELETE con Authorization y Content-Type, para el origen configurado. En ejecución local fuera de Docker, configurar `LIBRARY_ORIGIN=http://127.0.0.1:3002` en el Gateway; sin origen las rutas autenticadas responden 503. En Compose el origen se configura automáticamente. No expone rutas internas ni la salud de Library a través de un proxy genérico.

Las rutas `/api/v1/library/*` verifican JWT ES256 de Supabase mediante `shared/auth.ts` (firma, emisor, audiencia, expiración y `sub` UUID). Cada consulta filtra por el usuario verificado; no se aceptan identificadores de usuario desde la petición. Las respuestas privadas incluyen `Cache-Control: private, no-store`.

| Método y ruta | Respuesta |
| --- | --- |
| `GET /health/live` | `200 { "status": "ok" }`, público; verifica el proceso, no la base de datos. |
| `GET /api/v1/library/watchlist` | `200 { "results": [...] }`, orden descendente de creación. |
| `PUT /api/v1/library/watchlist/:media_type/:tmdb_id` | `200`, agrega o devuelve el elemento existente sin cambiar su fecha. |
| `DELETE /api/v1/library/watchlist/:media_type/:tmdb_id` | `204`, incluso si no existía; no borra el progreso. |
| `GET /api/v1/library/favorites` | `200 { "results": [...] }`, orden descendente de creación. |
| `PUT /api/v1/library/favorites/:media_type/:tmdb_id` | `200`, agrega o devuelve el favorito existente sin cambiar su fecha. |
| `DELETE /api/v1/library/favorites/:media_type/:tmdb_id` | `204`, incluso si no existía. |

`media_type` debe ser exactamente `movie` o `tv`; `tmdb_id` es un entero de 1 a 2147483647, sin ceros iniciales. No se admiten parámetros de consulta. PUT y DELETE no necesitan cuerpo; solo se permite un objeto JSON vacío si se envía alguno. El límite JSON es 1 KiB. Enviar siempre `Authorization: Bearer <access_token>`.

Las reglas de `media_type`, `tmdb_id` y cuerpo aplican igual a favoritos y watchlist.

Un elemento de watchlist tiene este formato (no expone el identificador del usuario):

```json
{
  "tmdb_id": 42,
  "media_type": "movie",
  "created_at": "2026-11-10T00:00:00.000Z",
  "status": "pending"
}
```

Un favorito tiene el mismo formato, sin `status`: `{ "tmdb_id": 42, "media_type": "movie", "created_at": "2026-11-10T00:00:00.000Z" }`. Favoritos y watchlist son listas independientes: agregar o quitar de una no modifica la otra. Como en watchlist, la respuesta no incluye título ni póster; el frontend los obtiene de Media.

`status` se deriva del registro existente en `Progress`: `in_progress`, `completed`, `on_hold` o `dropped`. Sin progreso es `pending`. Se actualiza mediante los endpoints de progreso, sin guardar otro estado en watchlist. `completed` es compatible con la interpretación actual de Recommendation. El listado no está paginado para conservar el contrato que utiliza ese servicio.

### Progreso de películas y series

Todas las rutas siguientes también se publican mediante el Gateway con JWT y `Cache-Control: private, no-store`.

| Método y ruta | Respuesta |
| --- | --- |
| `GET /api/v1/library/progress` | `200 { "results": [...] }`, orden descendente de actualización; lista vacía si no hay registros. |
| `PUT /api/v1/library/progress/:media_type/:tmdb_id` | `200`, crea o reemplaza estado y tiempos del contenido, conservando episodios existentes. |
| `PUT /api/v1/library/progress/tv/:tmdb_id/episodes/:season/:episode` | `200`, registra un episodio visto sin duplicarlo; crea el progreso de la serie si no existía. |
| `DELETE /api/v1/library/progress/tv/:tmdb_id/episodes/:season/:episode` | `204`, incluso si no existía; no elimina el progreso de la serie ni cambia su estado. |

PUT de progreso requiere `Content-Type: application/json` y un cuerpo como:

```json
{ "status": "in_progress", "position_seconds": 120, "duration_seconds": 7200 }
```

`status` es obligatorio y admite `in_progress`, `completed`, `on_hold` o `dropped`. Los tiempos son enteros (posición desde 0, duración desde 1) o null. Campos omitidos se reemplazan por null, pues es un PUT. La posición no puede superar una duración informada. Solo las películas admiten tiempos; en series se usan episodios y se envía, por ejemplo, `{ "status": "on_hold" }`. El estado es explícito: no se deduce de los segundos ni de la cantidad de episodios.

Cada respuesta de progreso contiene `tmdb_id`, `media_type`, `status`, `position_seconds`, `duration_seconds`, `updated_at` y `episodes`. Este último es una lista de `{ "season": 1, "episode": 2, "watched_at": "ISO" }`, ordenada por temporada y episodio. En películas es vacía. La temporada puede ser 0 (especiales) y el episodio empieza en 1. Se usan enteros hasta 2147483647; no se verifica su existencia contra TMDB. Marcar episodios no completa automáticamente la serie ni cambia un estado existente; repetir PUT conserva `watched_at`. Las rutas de episodios no requieren cuerpo, salvo un objeto JSON vacío opcional.

Los estados y tiempos se validan antes de escribir. El cliente no envía usuario, identificadores internos ni fecha de visualización. Cada lectura, actualización y borrado filtra por el `sub` del JWT.

Los errores responden `{ "error": "mensaje" }`: `400` por datos inválidos, `401` por token rechazado (con `WWW-Authenticate: Bearer`), `409` ante un conflicto de datos, `413` por JSON demasiado grande, `415` por codificación no admitida y `503` por indisponibilidad de autenticación o almacenamiento. Un fallo de base de datos no expone credenciales ni errores SQL.

### Ejecutar Library localmente

Desde la raíz del repositorio, prepara un único archivo local `library-service/.env`, excluido de Git, con `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL` y `SUPABASE_JWT_AUDIENCE=authenticated`. Los nombres y formatos generales están documentados en `.env.example`. Library debe usar el mismo proyecto y firma ES256 que el Gateway. `DIRECT_URL` se usa para las herramientas Prisma; el servidor exige `DATABASE_URL`.

Con la migración de Esdras ya aplicada:

```powershell
npm ci --ignore-scripts
node --env-file=library-service/.env ./node_modules/prisma/build/index.js generate --config ./library-service/prisma.config.ts
npm run build
node --env-file=library-service/.env dist/library-service/src/server.js
```

La migración de Esdras crea el perfil de los usuarios nuevos mediante el trigger `on_auth_user_created_butaca`. Para las cuentas registradas antes de aplicarla, Library también asegura el perfil en la primera escritura (PUT o POST), usando únicamente el `sub` verificado del JWT; las lecturas y los DELETE no crean perfiles. Si el perfil ya existe, no se modifica, y la llave foránea hacia `auth.users` impide crear perfiles de usuarios inexistentes. Los perfiles ya asegurados se recuerdan en memoria para no repetir la consulta. Esta API no crea usuarios de Supabase ni perfiles para otros identificadores.

En otra terminal:

```powershell
curl.exe -i http://127.0.0.1:3002/health/live
curl.exe -i http://127.0.0.1:3002/api/v1/library/watchlist
```

La segunda consulta sin token debe devolver 401. Para probar operaciones con datos reales, usar un access token del proyecto y comprobar que dos usuarios no comparten resultados.

### Verificar sin modificar Supabase

Después de generar el cliente, `npm test` compila y ejecuta las pruebas existentes y `test/watchlist.test.mjs`. Esta última publica claves JWKS temporales y usa un almacenamiento simulado para probar autenticación, contrato, duplicados, aislamiento HTTP, validación y errores. `test/watchlist-store.test.mjs` verifica el filtrado por usuario y la transformación del estado en las consultas Prisma con un adaptador simulado. `test/gateway-library.test.mjs` prueba Gateway y Library juntos, incluyendo CORS, cuerpo, JWT y DELETE 204. Estas pruebas no verifican permisos RLS, la migración aplicada ni conectividad real con PostgreSQL/Supabase.

`test/progress.test.mjs` cubre validación de estados/tiempos y el flujo HTTP Gateway → Library para películas, series y episodios, con aislamiento por usuario. La prueba opcional `test/library-postgres.test.mjs` requiere `LIBRARY_TEST_DATABASE_URL` y `LIBRARY_TEST_PROFILE_ID` (un perfil propio existente). Ejecuta los repositorios reales en una transacción que siempre revierte, sin dejar cambios persistidos. No crea usuarios ni aplica migraciones. Comprueba operaciones, unicidad, estado compartido y filtrado por usuario; no prueba el login OAuth ni políticas RLS con rol `authenticated`.

## Recommendation Service

Genera recomendaciones personales por reglas a partir de la biblioteca del usuario (Library Service) y del catálogo de Media Service. Compose lo ejecuta en el puerto interno 3003, sin publicarlo al host, con los mismos límites de recursos y healthcheck de proceso que los demás servicios.

El Gateway publica únicamente `GET /api/v1/recommendations`: valida el JWT, conserva la consulta y reenvía el Bearer verificado al servicio, que vuelve a autenticarlo. El timeout del Gateway es de 7 segundos. Para ejecutar fuera de Compose, configura `RECOMMENDATION_ORIGIN` en el Gateway (por ejemplo `http://127.0.0.1:3003`); sin esa variable la ruta autenticada responde 503.

Compose requiere `SUPABASE_URL`, el token de TMDB y `DATABASE_URL`. Library está incluido y su origen interno es `http://library-service:3002`. `RECOMMENDATIONS_CACHE_TTL_MS` permite ajustar la caché desde el archivo de entorno seleccionado.

| Variable | Uso |
| --- | --- |
| `SUPABASE_URL` | Obligatoria. URL del proyecto (`https://<ref>.supabase.co`). Define el emisor esperado (`<SUPABASE_URL>/auth/v1`) y la ubicación de las claves públicas (JWKS). |
| `SUPABASE_JWT_AUDIENCE` | Audiencia esperada. Por defecto, `authenticated`. |
| `SUPABASE_JWT_SECRET` | Opcional. Solo para proyectos que aún firman con el secreto JWT heredado (HS256); sin ella se verifican firmas ES256/RS256 con JWKS. |
| `MEDIA_ORIGIN` | Media Service. Por defecto, `http://127.0.0.1:3001`. |
| `LIBRARY_ORIGIN` | Library Service. Por defecto, `http://127.0.0.1:3002`. |
| `RECOMMENDATIONS_CACHE_TTL_MS` | Vigencia de las recomendaciones de cada usuario. Por defecto, 120000. |
| `RECOMMENDATIONS_BUDGET_MS` | Tiempo total para calcular una recomendación. Por defecto, 6000; debe ser menor que la espera del Gateway (7 s). |

### `GET /api/v1/recommendations`

Requiere `Authorization: Bearer <access_token>` de Supabase. Se verifican firma, emisor, audiencia, expiración y `sub`; el usuario se toma siempre del token, y el mismo token se reenvía a Library Service para que solo devuelva los registros de ese usuario.

| Parámetro | Obligatorio | Valores |
| --- | --- | --- |
| `media_type` | No | `all` (predeterminado), `movie` o `tv`. |
| `limit` | No | Entero de 1 a 40. Predeterminado 20. |
| `mood` | No | Emoción actual: `HAPPY`, `SAD`, `ANGRY`, `FEAR`, `DISGUSTED`, `SURPRISED` o `CALM` (los códigos del catálogo `library.moods`, en mayúsculas). |
| `language` | No | `es-MX` por defecto. |

```json
{
  "results": [
    {
      "id": 2, "media_type": "movie", "title": "Título", "poster_path": "/p.jpg", "overview": "",
      "release_date": "2024-05-01", "vote_average": 7.1, "genre_ids": [28, 12],
      "score": 0.812, "reasons": ["genres", "trending", "popular"]
    }
  ],
  "mood": null,
  "based_on": { "favorites": 3, "watchlist": 5, "progress": 1 }
}
```

`mood` repite la emoción solicitada, o `null` si no se envió. `reasons` puede contener `mood` (coincide con los géneros de la emoción), `genres` (coincide con los géneros del usuario), `trending`, `popular` y `top_rated` (calificación de 7,5 o más). Si `based_on` está en cero, el usuario todavía no tiene señales y se devuelven títulos populares y en tendencia. La respuesta lleva `Cache-Control: private, no-store`.

Reglas:

1. Se infieren los géneros preferidos a partir de hasta 20 títulos de la biblioteca: favoritos (peso 3), contenido visto (peso 2) y pendientes de la watchlist (peso 1). Los géneros de series y películas equivalentes se relacionan, por ejemplo Action & Adventure con Acción y Aventura.
2. Los candidatos son las dos primeras páginas de populares de cada tipo y las tendencias del día.
3. Se excluye todo lo que ya está en la biblioteca del usuario, incluido el contenido visto.
4. La puntuación combina afinidad de géneros (60 %), posición en populares (15 %), calificación (15 %) y tendencia (10 %). Sin señales del usuario se usan solo popularidad (45 %), calificación (35 %) y tendencia (20 %).
5. Con `mood`, la coincidencia con los géneros de esa emoción pesa más: 45 % con historial (afinidad 30 %, popularidad 10 %, calificación 10 %, tendencia 5 %) o 55 % sin historial (popularidad 20 %, calificación 15 %, tendencia 10 %). Con emociones negativas se busca aligerar el ánimo: por ejemplo, con `SAD` se priorizan comedia, familia y animación, y con `FEAR` se evita el terror. Los géneros a evitar (`MOOD_AVOID`) reducen la puntuación a la mitad. Las tablas están en `recommendation-service/src/moods.ts` y pueden ajustarse sin cambiar el contrato.

El cálculo tiene un presupuesto total de `RECOMMENDATIONS_BUDGET_MS`: cada llamada a Media o Library espera como máximo lo que queda, y si se agota responde 504 antes que el Gateway. Los géneros de los títulos de la biblioteca se piden apenas responde Library, en paralelo con populares y tendencias. Si falla o tarda el detalle de un título, se omite esa señal en lugar de fallar toda la recomendación. Con TMDB real y 20 títulos en la biblioteca, el cálculo sin caché tardó alrededor de 1 s.

Cada resultado se guarda en una caché temporal por usuario (clave: `sub` verificado, tipo, idioma y emoción), por lo que los cambios en la biblioteca se reflejan cuando vence `RECOMMENDATIONS_CACHE_TTL_MS`.

| HTTP | Significado |
| --- | --- |
| 400 | Parámetro desconocido o inválido. |
| 401 | Falta el token, o es inválido, expiró o Library Service lo rechazó. |
| 502 | Media o Library no disponibles, o respondieron con un formato inesperado. |
| 503 | No fue posible obtener las claves públicas de Supabase. |
| 504 | Venció el tiempo de espera de un servicio. |

### Contrato con Library Service

Recommendation Service consulta `GET /api/v1/library/favorites`, `/watchlist` y `/progress` con el mismo Bearer token. Cada una responde `{ "results": [...] }` con elementos que incluyen `tmdb_id` y `media_type`. Un elemento se considera visto cuando su `status` es `completed`, tanto en watchlist como en progreso (también se aceptan `completed: true` y otros sinónimos como `watched`). Favoritos y watchlist son obligatorios: si alguna de esas rutas responde 404, la consulta falla con 502 para no confundir una integración incompleta con una biblioteca vacía ni recomendar contenido ya visto. Progreso sigue marcado como opcional (`OPTIONAL_LISTS`): su 404 se trata como lista vacía. Ya está implementado, así que puede volverse obligatorio cuando el equipo lo decida. Si el contrato final difiere, solo hay que ajustar `recommendation-service/src/sources.ts`.
