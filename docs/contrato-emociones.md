# Contrato de expresiones faciales

Las rutas pasan por el Gateway, requieren `Authorization: Bearer <access_token>` de Supabase y nunca aceptan identificadores de usuario desde el cliente: el usuario sale siempre del JWT. Todas las entradas se validan con Zod; un error responde `{ "error": "mensaje" }` con el campo que falló.

**La imagen solo viaja una vez**, a `POST /api/v1/emotions/analyze`, que es efímero: devuelve una sugerencia y no guarda nada. Lo que se guarda es la emoción que el usuario **confirma**, con `POST /api/v1/emotions/history`, sin imagen. La antigua ruta `POST /api/v1/emotions/detections` se eliminó: volvía a recibir la foto, la analizaba otra vez con Rekognition (doble costo) e ignoraba la confirmación del usuario.

## Flujo para el frontend

1. Explicar que la captura se enviará a AWS y pedir consentimiento explícito: `PUT /api/v1/emotions/consent`.
2. Encender la cámara solo por acción del usuario.
3. Capturar un JPEG o PNG, apagar la cámara y enviarlo como `FormData` a `POST /api/v1/emotions/analyze`.
4. Mostrar la expresión como sugerencia, nunca como estado emocional real, y pedir confirmación.
5. Guardar la emoción confirmada con `POST /api/v1/emotions/history` (incluye `confidence` solo si se confirmó la sugerencia).
6. Pedir recomendaciones con `GET /api/v1/recommendations?mood=<código>` y guardar la elegida con `PUT /api/v1/emotions/history/:id/recommendations/...`.
7. Historial: `GET /api/v1/emotions/history`. Tablero: `GET /api/v1/emotions/summary`.

## Códigos de emociones

Son los del catálogo `library.moods` y son el contrato: el frontend los envía y recibe tal cual (en mayúsculas). Puede traducirlos a sus propias claves, nombres o colores, pero debe contemplar los siete.

| Código | Nombre en el catálogo |
| --- | --- |
| `HAPPY` | Felicidad |
| `SAD` | Tristeza |
| `ANGRY` | Enojo |
| `FEAR` | Miedo |
| `DISGUSTED` | Desagrado |
| `SURPRISED` | Sorpresa |
| `CALM` | Neutralidad / calma |

Rekognition también puede devolver `CONFUSED` y `UNKNOWN`. No se convierten silenciosamente a otra categoría: si una de ellas es la principal, la respuesta no incluye sugerencia y usa `reason: "unsupported_expression"`.

## Análisis efímero

`POST /api/v1/emotions/analyze`

Headers:

```http
Authorization: Bearer <access_token>
Content-Type: multipart/form-data; boundary=...
```

Campos permitidos, exactamente:

| Campo | Regla |
| --- | --- |
| `image` | Exactamente un archivo JPEG (`image/jpeg`) o PNG (`image/png`), máximo 2 MiB. Se comprueban MIME y firma real del contenido. |
| `consent` | Exactamente el texto `true`. No se aceptan booleanos JSON, valores alternativos ni campos adicionales. |

Ejemplo desde Frontend:

```js
const form = new FormData();
form.append('image', imageBlob, 'capture.jpg');
form.append('consent', 'true');

const response = await fetch(`${apiUrl}/api/v1/emotions/analyze`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: form
});
```

El navegador establece `Content-Type` junto con el `boundary`; no debe configurarse manualmente al usar `FormData`.

Respuesta con sugerencia:

```json
{
  "suggestedExpression": "HAPPY",
  "confidence": 92.34,
  "confirmationRequired": true,
  "faces": 1,
  "reason": null
}
```

Cuando la categoría principal no está en el catálogo o no alcanza el umbral configurable:

```json
{
  "suggestedExpression": null,
  "confidence": null,
  "confirmationRequired": true,
  "faces": 1,
  "reason": "unsupported_expression"
}
```

`reason` puede ser `unsupported_expression` o `insufficient_confidence`. La confianza va de 0 a 100 y expresa la confianza de la predicción, no la intensidad de una emoción. `EMOTION_MIN_CONFIDENCE` es un umbral del producto, no un requisito de AWS.

| HTTP | Significado |
| --- | --- |
| 400 | Falta consentimiento/archivo, hay archivos o campos adicionales, o el multipart es inválido. |
| 401 | Token ausente, inválido o expirado. El cuerpo no se procesa antes de autenticar. |
| 413 | El archivo supera 2 MiB. |
| 415 | Content-Type incorrecto, MIME no admitido o contenido que no coincide con JPEG/PNG. |
| 422 | No se detectó ningún rostro o se detectó más de uno. |
| 429 | Límite por usuario o limitación de AWS; respetar `Retry-After`. |
| 502 | Rekognition no disponible o rechazó la operación. |
| 503 | `AWS_REGION` no está configurada. |
| 504 | Venció el tiempo configurado para AWS o el Gateway. |

La imagen se procesa en memoria y este backend no la escribe en disco, logs ni Supabase. Se envía como bytes a `DetectFaces` con `Attributes: ["EMOTIONS"]`; no se usa S3 ni identificación facial. El tratamiento dentro de AWS depende de la configuración de la cuenta y de sus políticas vigentes; consultar [protección de datos](https://docs.aws.amazon.com/rekognition/latest/dg/data-protection.html) y [cifrado](https://docs.aws.amazon.com/rekognition/latest/dg/security-data-encryption.html).

## Consentimiento

| Método y ruta | Cuerpo | Respuesta |
| --- | --- | --- |
| `GET /api/v1/emotions/consent` | Ninguno | `200 { "granted": false, "policy_version": null, "granted_at": null }` |
| `PUT /api/v1/emotions/consent` | `{ "policy_version": "2026-11" }` | `200 { "granted": true, "policy_version": "2026-11", "granted_at": "…" }` |
| `DELETE /api/v1/emotions/consent` | Ninguno | `204`; los registros nuevos vuelven a responder 403 |

`policy_version` identifica el texto de consentimiento que vio el usuario (hasta 50 caracteres: letras, números, punto o guion). Si cambia el texto, se cambia la versión y se vuelve a pedir.

## Registro de la emoción confirmada

`POST /api/v1/emotions/history`

```json
{ "mood": "SAD", "confidence": 91.2, "time_zone": "America/Guatemala" }
```

| Campo | Regla |
| --- | --- |
| `mood` | Obligatorio. Uno de los siete códigos del catálogo. |
| `confidence` | Opcional, de 0 a 100 o `null`. Enviar la confianza que devolvió `/analyze` solo si el usuario confirmó esa misma sugerencia; si eligió otra emoción, omitirla. |
| `time_zone` | Opcional. Zona IANA del navegador (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Define el día local del registro y se guarda en el perfil. Sin ella se usa la del perfil (UTC por defecto). |

No se admiten otros campos (en particular, ni imagen ni identificadores de usuario). Requiere consentimiento vigente (403 si no lo hay). Cuerpo máximo: 1 KiB.

Respuesta `201` (primer registro del día) o `200` (reemplaza el registro de ese día y conserva sus recomendaciones guardadas):

```json
{
  "id": "6f1c…",
  "date": "2026-11-10",
  "mood": "SAD",
  "name": "Tristeza",
  "confidence": 91.2,
  "source": "AWS_REKOGNITION",
  "scores": [{ "mood": "SAD", "confidence": 91.2 }],
  "detected_at": "2026-11-10T21:15:04.120Z",
  "recommendations": [],
  "replaced": false
}
```

`source` es `AWS_REKOGNITION` cuando se confirmó la sugerencia del análisis (con su confianza) y `USER_SELECTED` cuando el usuario eligió la emoción (`confidence: null`). La confianza la reporta el cliente a partir de `/analyze` y se usa solo para mostrarla.

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
      "source": "AWS_REKOGNITION",
      "scores": [{ "mood": "SAD", "confidence": 91.2 }],
      "detected_at": "2026-11-10T21:15:04.120Z",
      "recommendations": [
        {
          "tmdb_id": 354912, "media_type": "movie", "title": "Coco", "poster_path": "/coco.jpg",
          "overview": null, "release_date": "2017-10-27", "vote_average": 8.2, "genre_ids": [16, 10751],
          "saved_at": "2026-11-10T21:16:00.000Z",
          "mood": "SAD", "mood_name": "Tristeza", "mood_detected_at": "2026-11-10T21:15:04.120Z"
        }
      ]
    }
  ]
}
```

Los días sin registro no aparecen.

Cada recomendación guardada trae **su propia emoción** (`mood`, `mood_name`, `mood_detected_at`): la que tenía el día en el momento de guardarla (columna `mood_code_at_save`). Si el usuario vuelve a analizarse el mismo día, cambia la emoción del día (`mood` del registro), pero las recomendaciones anteriores conservan la suya. El frontend debe mostrar la emoción de la recomendación, no la del día.

## Resumen para el tablero

`GET /api/v1/emotions/summary?period=7d` · `?period=30d` (predeterminado) · `?period=year` (año en curso, del 1 de enero a hoy)

Agrega el historial en el backend para que el tablero no tenga que calcularlo:

```json
{
  "period": "30d",
  "from": "2026-10-14",
  "to": "2026-11-12",
  "total_records": 12,
  "days_with_records": 12,
  "predominant": { "mood": "HAPPY", "name": "Felicidad", "count": 5 },
  "distribution": [
    { "mood": "HAPPY", "name": "Felicidad", "count": 5 },
    { "mood": "SAD", "name": "Tristeza", "count": 3 }
  ],
  "timeline": [
    { "bucket": "2026-11-11", "counts": { "HAPPY": 1, "SAD": 0, "ANGRY": 0, "FEAR": 0, "DISGUSTED": 0, "SURPRISED": 0, "CALM": 0 } }
  ],
  "recommendations": {
    "total": 7,
    "by_media_type": { "movie": 5, "tv": 2 },
    "by_mood": [{ "mood": "HAPPY", "name": "Felicidad", "count": 3 }],
    "by_genre": [{ "genre_id": 35, "count": 4 }],
    "recent": [{ "tmdb_id": 354912, "media_type": "movie", "title": "Coco", "mood": "SAD", "mood_name": "Tristeza", "date": "2026-11-10", "saved_at": "…" }]
  }
}
```

- `distribution` y `by_mood` incluyen siempre las siete emociones, también con `count: 0`.
- `predominant` es `null` si no hay registros en el período.
- `timeline` tiene un punto por día en `7d`/`30d` y uno por mes (`YYYY-MM`) en `year`, incluidos los vacíos, para graficar sin huecos.
- `by_genre` lista los 10 géneros más recomendados; sus nombres se obtienen de `GET /api/v1/media/genres`.
- `recent` trae las últimas 5 recomendaciones guardadas, cada una con su propia emoción.
- `by_mood` cuenta las recomendaciones por la emoción con la que se hizo cada una.

## Recomendación guardada

`PUT /api/v1/emotions/history/:id/recommendations/:media_type/:tmdb_id`

```json
{ "title": "Coco", "poster_path": "/coco.jpg", "release_date": "2017-10-27", "vote_average": 8.2, "genre_ids": [16, 10751] }
```

`title` es obligatorio; los demás campos son opcionales (`overview`, `poster_path`, `release_date`, `vote_average` de 0 a 10, `genre_ids` hasta 20). Es idempotente: repetirlo actualiza el título guardado. Se guarda una copia de los datos para mostrar el historial sin consultar TMDB. Responde 404 si el registro no existe o es de otro usuario.

## Decisiones tomadas

| Tema | Decisión | Motivo |
| --- | --- | --- |
| Ruta con imagen | Solo `/analyze`. `/detections` se eliminó. | La foto viaja una vez, se paga un solo análisis y se respeta lo que confirma el usuario. |
| Registros por día | **Uno por usuario y día** local. Confirmar otra emoción ese día reemplaza el registro y conserva sus recomendaciones. | Es lo que garantiza el esquema (`mood_history_profile_date_key`) y lo que muestran el mapa anual y el tablero (un color por día). Varios registros con hora requerirían una migración y no aportan al caso de uso de Majo (qué ver esta noche). |
| Códigos | Los siete del catálogo, en mayúsculas, son el contrato. El frontend agrega `CALM` y traduce `FEAR` a su clave interna. | Un único vocabulario entre base de datos, AWS, recomendaciones y frontend. |
| Umbral mínimo | 30 de confianza (`EMOTION_MIN_CONFIDENCE`, de 1 a 100). Por debajo, `/analyze` no sugiere y el usuario puede reintentar. | Rekognition reparte la confianza entre emociones; 30 descarta resultados ambiguos sin rechazar expresiones neutras. Ajustable sin cambiar código. |
| Relación emoción → géneros | Tabla en `recommendation-service/src/moods.ts`: con emociones negativas se busca aligerar el ánimo y se evita, por ejemplo, el terror con miedo. | Ajustar la tabla no cambia el contrato. |
| Conservación | No se guardan imágenes; se guardan la emoción confirmada, su confianza (si la hubo), el origen y la fecha. | Privacidad de la cámara. |

## Configuración del servidor

Library Service necesita `AWS_REGION` y una identidad AWS con permiso `rekognition:DetectFaces`. El SDK usa la cadena estándar de credenciales: roles y perfiles son preferibles; `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` se usan solo cuando el entorno realmente necesita credenciales explícitas. Las credenciales nunca van al frontend, argumentos de build ni logs.

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "rekognition:DetectFaces", "Resource": "*" }]
}
```

Todas las variables se validan con Zod al arrancar (ver `shared/config.ts`); si una es inválida, el servicio no inicia y el mensaje indica cuál. Configuración adicional: `EMOTION_AWS_TIMEOUT_MS` (5000), `EMOTION_MIN_CONFIDENCE` (30), `EMOTION_ANALYZE_LIMIT` (10) y `EMOTION_ANALYZE_WINDOW_MS` (60000). El cliente usa dos intentos totales como máximo. Library espera hasta 5 s por AWS y el Gateway hasta 8 s.

Las pruebas normales usan un detector sustituible y no necesitan credenciales ni consumen AWS. Ejecutar `npm test` después de generar Prisma. La validación real con una imagen y una cuenta AWS requiere autorización expresa y no forma parte de la suite automatizada.

