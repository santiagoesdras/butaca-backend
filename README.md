# Butaca Backend

El API Gateway recibe las consultas del cliente en el puerto 8080. Media Service consulta TMDB y devuelve películas y series normalizadas. Ambos servicios usan Node.js 24, TypeScript y Express.

## Ejecutar con Docker Compose

Desde la raíz del repositorio, crea una copia local de `.env.example` llamada `.env`. En PowerShell puedes usar `Copy-Item .env.example .env` si todavía no tienes un archivo `.env`.

| Variable | Uso |
| --- | --- |
| `TMDB_READ_ACCESS_TOKEN` | Token de lectura de la API de TMDB. Solo lo recibe Media Service. |
| `FRONTEND_ORIGIN` | Origen permitido por CORS. Por defecto, `http://localhost:5173`. |
| `CACHE_TTL_MS` | Vigencia de las respuestas de TMDB en caché, en milisegundos. Por defecto, 300000. |
| `CACHE_MAX_ENTRIES` | Máximo de entradas en memoria por tipo de consulta. Por defecto, 64. |

Con Docker y el complemento Compose disponibles, ejecuta:

```sh
docker compose up --build -d
docker compose ps
curl -i http://127.0.0.1:8080/health/live
curl -i "http://127.0.0.1:8080/api/v1/media/trending?language=es-MX"
```

En Windows PowerShell usa `curl.exe`. Ambos servicios deben aparecer como saludables. La consulta de tendencias con un token válido debe responder con HTTP 200 y un objeto con `page` y `results`.

Compose publica el Gateway en el loopback del host. Media Service escucha en el puerto 3001 dentro de la red de Compose y necesita salida HTTPS hacia TMDB. Cada contenedor tiene un límite inicial de 192 MiB. Los healthchecks consultan `/health/live` y comprueban el proceso independientemente de TMDB. Para detener este proyecto, ejecuta `docker compose down` desde su raíz.

## Verificar sin credenciales

```sh
npm ci
npm test
```

Las pruebas compilan en modo estricto, levantan los servicios en puertos locales temporales y simulan TMDB por HTTP. Cubren salud, normalización, solicitudes concurrentes, caché, validación de parámetros y recuperación tras errores del proveedor.

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
