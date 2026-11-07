# Butaca Backend

El API Gateway recibe las consultas del cliente en el puerto 8080. Media Service consulta las tendencias diarias de TMDB y devuelve películas y series en su orden original. Ambos servicios usan Node.js 24, TypeScript y Express.

## Ejecutar con Docker Compose

Desde la raíz del repositorio, crea una copia local de `.env.example` llamada `.env`. En PowerShell puedes usar `Copy-Item .env.example .env` si todavía no tienes un archivo `.env`.

| Variable | Uso |
| --- | --- |
| `TMDB_READ_ACCESS_TOKEN` | Token de lectura de la API de TMDB. Solo lo recibe Media Service. |
| `FRONTEND_ORIGIN` | Origen permitido por CORS. Por defecto, `http://localhost:5173`. |
| `CACHE_TTL_MS` | Vigencia de las tendencias por idioma, en milisegundos. Por defecto, 300000. |
| `CACHE_MAX_ENTRIES` | Máximo de entradas en memoria. Por defecto, 64. |

Con Docker y el complemento Compose disponibles, ejecuta:

```sh
docker compose up --build -d
docker compose ps
curl -i http://127.0.0.1:8080/health/live
curl -i "http://127.0.0.1:8080/api/v1/media/trending?language=es-MX"
```

En Windows PowerShell usa `curl.exe`. Ambos servicios deben aparecer como saludables. La consulta de tendencias con un token válido debe responder con HTTP 200 y un objeto con `page` y `results`. Cada resultado contiene `id`, `media_type`, `title` y `poster_path` (puede ser nulo). Solo se expone la primera página diaria. El idioma por defecto es `es-MX`.

Compose publica el Gateway en el loopback del host. Media Service escucha en el puerto 3001 dentro de la red de Compose y necesita salida HTTPS hacia TMDB. Cada contenedor tiene un límite inicial de 192 MiB. Los healthchecks consultan `/health/live` y comprueban el proceso independientemente de TMDB. Para detener este proyecto, ejecuta `docker compose down` desde su raíz.

## Verificar sin credenciales

```sh
npm ci
npm test
```

La prueba compila en modo estricto, levanta ambos servicios en puertos locales temporales y simula TMDB por HTTP. Cubre salud, normalización, solicitudes concurrentes, caché, validación de idioma y recuperación tras errores del proveedor.

## Comportamiento del endpoint

El Gateway limita las rutas de la API a 120 solicitudes por minuto por IP y espera hasta 7 segundos a Media Service. Este último espera hasta 4,5 segundos a TMDB y comparte las consultas en curso para el mismo idioma. Al expirar una entrada vuelve a consultar al proveedor. Los errores se devuelven como JSON con el campo `error`.

| HTTP | Significado |
| --- | --- |
| 400 | Parámetro desconocido o idioma inválido. |
| 429 | Límite del Gateway o del proveedor. Se reenvía el plazo de TMDB cuando llega en segundos. |
| 502 | Servicio inaccesible, respuesta inválida o rechazo de las credenciales de TMDB. |
| 504 | Venció el tiempo de espera de una consulta. |

Datos de tendencias suministrados por [TMDB](https://developer.themoviedb.org/reference/trending-all).

