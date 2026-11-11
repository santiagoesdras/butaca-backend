# Contrato de emociones

Propuesta implementada en la rama `feature/emotions`. Las rutas pasan por el Gateway, requieren `Authorization: Bearer <access_token>` de Supabase y nunca aceptan identificadores de usuario desde el cliente: el usuario sale siempre del JWT.

## Flujo para el frontend

1. Mostrar la finalidad del análisis y pedir consentimiento: `PUT /api/v1/emotions/consent`.
2. Encender la cámara solo después del consentimiento y por acción del usuario.
3. Capturar un cuadro (por ejemplo, `canvas.toDataURL('image/jpeg', 0.8)`), apagar la cámara y enviarlo a `POST /api/v1/emotions/detections`.
4. Mostrar el resultado como una estimación y pedir recomendaciones con `GET /api/v1/recommendations?mood=<código>`.
5. Si el usuario elige un título, guardarlo con `PUT /api/v1/emotions/history/:id/recommendations/:media_type/:tmdb_id`.
6. Historial y dashboard consultan `GET /api/v1/emotions/history`.

## Códigos de emociones

Son los del catálogo `library.moods`. El frontend debe usar estos códigos en las peticiones y puede traducirlos a sus propios nombres o colores.

| Código | Nombre en el catálogo | Valor actual en el frontend |
| --- | --- | --- |
| `HAPPY` | Felicidad | `happy` |
| `SAD` | Tristeza | `sad` |
| `ANGRY` | Enojo | `angry` |
| `FEAR` | Miedo | `fearful` |
| `DISGUSTED` | Desagrado | `disgusted` (mostrado como "Asco") |
| `SURPRISED` | Sorpresa | `surprised` |
| `CALM` | Neutralidad / calma | No existe: hay que agregarlo |

Rekognition también devuelve `CONFUSED`, que se suma a `SURPRISED`, y `UNKNOWN`, que se descarta.

## Consentimiento

| Método y ruta | Cuerpo | Respuesta |
| --- | --- | --- |
| `GET /api/v1/emotions/consent` | Ninguno | `200 { "granted": false, "policy_version": null, "granted_at": null }` |
| `PUT /api/v1/emotions/consent` | `{ "policy_version": "2026-11" }` | `200 { "granted": true, "policy_version": "2026-11", "granted_at": "…" }` |
| `DELETE /api/v1/emotions/consent` | Ninguno | `204`; las detecciones nuevas vuelven a responder 403 |

`policy_version` identifica el texto de consentimiento que vio el usuario (hasta 50 caracteres: letras, números, punto o guion). Si cambia el texto, se cambia la versión y se vuelve a pedir.

## Detección

`POST /api/v1/emotions/detections`

```json
{
  "image": "data:image/jpeg;base64,/9j/4AAQ…",
  "time_zone": "America/Guatemala"
}
```

| Campo | Regla |
| --- | --- |
| `image` | Obligatorio. JPEG o PNG en base64, con o sin prefijo `data:image/...;base64,`. Máximo 2 MB ya decodificado. Se comprueba el formato real por sus primeros bytes. |
| `time_zone` | Opcional. Zona IANA del navegador (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Define el día local del registro y se guarda en el perfil. Sin ella se usa la del perfil (UTC por defecto). |

Respuesta `201` (primer registro del día) o `200` (reemplaza el registro de ese día):

```json
{
  "id": "6f1c…",
  "date": "2026-11-10",
  "mood": "SAD",
  "name": "Tristeza",
  "confidence": 91.2,
  "scores": [
    { "mood": "SAD", "confidence": 91.2 },
    { "mood": "CALM", "confidence": 6.1 }
  ],
  "detected_at": "2026-11-10T21:15:04.120Z",
  "recommendations": [],
  "faces": 1,
  "replaced": false
}
```

`confidence` va de 0 a 100. Con varios rostros se analiza el más grande; `faces` indica cuántos se encontraron. **La imagen no se guarda**: solo se envía a Rekognition y se descarta.

| HTTP | Significado |
| --- | --- |
| 400 | Cuerpo inválido, campo desconocido o zona horaria inválida. |
| 401 | Sin sesión o token inválido. |
| 403 | El usuario no ha dado (o revocó) el consentimiento. |
| 413 | La imagen supera 2 MB. |
| 415 | La imagen no es JPEG ni PNG. |
| 422 | No se detectó un rostro, o la emoción principal tiene menos de 30 de confianza. |
| 429 | Límite de Rekognition; respetar `Retry-After`. |
| 502 | Rekognition no disponible. |
| 503 | Detección no configurada en el servidor (faltan credenciales de AWS). |
| 504 | El análisis tardó demasiado. |

## Historial

`GET /api/v1/emotions/history?period=7d` · `?period=30d` (predeterminado) · `?year=2026`

- `period` cuenta días hasta hoy en la zona horaria del perfil.
- `year` devuelve el año calendario completo, para el mapa anual.
- No se pueden combinar.

```json
{
  "results": [
    {
      "id": "6f1c…",
      "date": "2026-11-10",
      "mood": "SAD",
      "name": "Tristeza",
      "confidence": 91.2,
      "scores": [{ "mood": "SAD", "confidence": 91.2 }],
      "detected_at": "2026-11-10T21:15:04.120Z",
      "recommendations": [
        {
          "tmdb_id": 354912, "media_type": "movie", "title": "Coco", "poster_path": "/coco.jpg",
          "overview": null, "release_date": "2017-10-27", "vote_average": 8.2, "genre_ids": [16, 10751],
          "saved_at": "2026-11-10T21:16:00.000Z"
        }
      ]
    }
  ]
}
```

Los días sin registro no aparecen. El dashboard puede calcular la distribución, la emoción predominante y el total de películas recomendadas a partir de esta lista.

## Recomendación guardada

`PUT /api/v1/emotions/history/:id/recommendations/:media_type/:tmdb_id`

```json
{ "title": "Coco", "poster_path": "/coco.jpg", "release_date": "2017-10-27", "vote_average": 8.2, "genre_ids": [16, 10751] }
```

`title` es obligatorio; los demás campos son opcionales (`overview`, `poster_path`, `release_date`, `vote_average` de 0 a 10, `genre_ids` hasta 20). Es idempotente: repetirlo actualiza el título guardado. Se guarda una copia de los datos para mostrar el historial sin consultar TMDB. Responde 404 si el registro no existe o es de otro usuario.

## Decisiones que el equipo debe confirmar

| Tema | Implementado así | Alternativa |
| --- | --- | --- |
| Registros por día | **Uno por usuario y día**, como exige el esquema (`mood_history_profile_date_key`). Una nueva detección el mismo día reemplaza la anterior y conserva sus recomendaciones guardadas. | Para varios registros con hora, como muestra el mockup del historial, hay que quitar esa restricción con una migración. |
| Entrada | Solo imagen de cámara, por acción del usuario. | Agregar selección manual de emoción. |
| Umbral mínimo | 30 de confianza. | Ajustar con pruebas reales. |
| Relación emoción → géneros | Tabla en `recommendation-service/src/moods.ts`: con emociones negativas se busca aligerar el ánimo y se evita, por ejemplo, el terror con miedo. | Ajustar la tabla; no cambia el contrato. |
| Conservación | No se guardan imágenes; se guardan la emoción, los puntajes y la fecha. | — |

## Configuración del servidor

Library Service necesita `AWS_REGION`, `AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY` de un usuario IAM con permiso únicamente para `rekognition:DetectFaces`. Sin `AWS_REGION`, consentimiento e historial funcionan y la detección responde 503. Las credenciales nunca van al frontend.
