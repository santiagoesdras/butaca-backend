# Contrato de expresiones faciales

Las rutas pasan por el Gateway, requieren `Authorization: Bearer <access_token>` de Supabase y nunca aceptan identificadores de usuario desde el cliente: el usuario sale siempre del JWT.

El contrato principal para una captura nueva es `POST /api/v1/emotions/analyze`. Es efímero: valida consentimiento, envía la imagen a Amazon Rekognition y devuelve una sugerencia para que el usuario la confirme o corrija. No guarda la imagen, la estimación, el consentimiento ni un registro de historial.

## Flujo para el frontend

1. Explicar que la captura se enviará a AWS y pedir consentimiento explícito.
2. Encender la cámara solo por acción del usuario.
3. Capturar un JPEG o PNG, apagar la cámara y enviarlo como `FormData` a `/api/v1/emotions/analyze`.
4. Mostrar la expresión como sugerencia, nunca como estado emocional real, y pedir confirmación o corrección.
5. La persistencia y las recomendaciones basadas en la confirmación se coordinan por separado.

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

## Flujo persistente existente

Las rutas siguientes ya existían antes del contrato efímero. Persisten consentimiento, detecciones e historial y pertenecen a la coordinación con los responsables de historial y recomendaciones. El frontend nuevo debe preferir `/analyze` hasta que ese equipo confirme el flujo persistente.

## Consentimiento

| Método y ruta | Cuerpo | Respuesta |
| --- | --- | --- |
| `GET /api/v1/emotions/consent` | Ninguno | `200 { "granted": false, "policy_version": null, "granted_at": null }` |
| `PUT /api/v1/emotions/consent` | `{ "policy_version": "2026-11" }` | `200 { "granted": true, "policy_version": "2026-11", "granted_at": "…" }` |
| `DELETE /api/v1/emotions/consent` | Ninguno | `204`; las detecciones nuevas vuelven a responder 403 |

`policy_version` identifica el texto de consentimiento que vio el usuario (hasta 50 caracteres: letras, números, punto o guion). Si cambia el texto, se cambia la versión y se vuelve a pedir.

## Detección persistente existente

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

`confidence` va de 0 a 100. Con varios rostros se analiza el más grande; `faces` indica cuántos se encontraron. **La imagen no se guarda**: solo se envía a Rekognition y se descarta. Esta conducta heredada no aplica a `/analyze`, que exige un solo rostro y no persiste el resultado.

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

Library Service necesita `AWS_REGION` y una identidad AWS con permiso `rekognition:DetectFaces`. El SDK usa la cadena estándar de credenciales: roles y perfiles son preferibles; `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` se usan solo cuando el entorno realmente necesita credenciales explícitas. Las credenciales nunca van al frontend, argumentos de build ni logs.

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "rekognition:DetectFaces", "Resource": "*" }]
}
```

Configuración adicional: `EMOTION_AWS_TIMEOUT_MS` (5000), `EMOTION_MIN_CONFIDENCE` (30), `EMOTION_ANALYZE_LIMIT` (10) y `EMOTION_ANALYZE_WINDOW_MS` (60000). El cliente usa dos intentos totales como máximo. Library espera hasta 5 s por AWS y el Gateway hasta 8 s.

Las pruebas normales usan un detector sustituible y no necesitan credenciales ni consumen AWS. Ejecutar `npm test` después de generar Prisma. La validación real con una imagen y una cuenta AWS requiere autorización expresa y no forma parte de la suite automatizada.

Pendencias de coordinación: Esdras/Sebastián deben decidir cómo se guarda una expresión confirmada/corregida y cómo se consume en historial y recomendaciones. `/analyze` no modifica modelos ni la restricción existente de un registro diario.
