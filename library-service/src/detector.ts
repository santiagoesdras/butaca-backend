import { DetectFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { HttpFailure } from '../../shared/http.js';
import { DEFAULT_MOODS, type MoodCode } from './constants/moods.js';

export type MoodScore = { mood: MoodCode; confidence: number };
export type Detection = { faces: number; scores: MoodScore[] };

export interface EmotionDetector {
  /** Analiza una imagen JPEG o PNG y devuelve las emociones del rostro principal, de mayor a menor confianza. */
  detect(image: Uint8Array): Promise<Detection>;
}

const CODES = new Set<string>(DEFAULT_MOODS.map(mood => mood.code));
// Rekognition también devuelve CONFUSED, que no está en el catálogo: se suma a SURPRISED. UNKNOWN se descarta.
const ALIASES: Record<string, MoodCode> = { CONFUSED: 'SURPRISED' };

/** Convierte las emociones de Rekognition a los códigos de library.moods, con confianza de 0 a 100. */
export function toScores(emotions: { Type?: string; Confidence?: number }[]): MoodScore[] {
  const totals = new Map<MoodCode, number>();
  for (const { Type, Confidence } of emotions) {
    const code = Type && (ALIASES[Type] ?? (CODES.has(Type) ? Type as MoodCode : undefined));
    if (!code || typeof Confidence !== 'number' || !Number.isFinite(Confidence)) continue;
    totals.set(code, Math.min(100, (totals.get(code) ?? 0) + Confidence));
  }
  return [...totals].map(([mood, confidence]) => ({ mood, confidence: Math.round(confidence * 100) / 100 }))
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Detector con AWS Rekognition (DetectFaces con el atributo EMOTIONS). Las credenciales se toman de la
 * cadena estándar de AWS (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY y AWS_REGION) y nunca llegan al cliente.
 * La imagen solo se envía a Rekognition; no se guarda.
 */
export function rekognitionDetector(region: string, timeout = 5000): EmotionDetector {
  const client = new RekognitionClient({ region, maxAttempts: 2 });
  return {
    async detect(image) {
      const signal = AbortSignal.timeout(timeout);
      try {
        const result = await client.send(new DetectFacesCommand({ Image: { Bytes: image }, Attributes: ['EMOTIONS'] }), { abortSignal: signal });
        const faces = result.FaceDetails ?? [];
        // Con varios rostros se analiza el de mayor tamaño en la imagen.
        const area = (face: (typeof faces)[number]) => (face.BoundingBox?.Width ?? 0) * (face.BoundingBox?.Height ?? 0);
        const main = [...faces].sort((a, b) => area(b) - area(a))[0];
        return { faces: faces.length, scores: main ? toScores(main.Emotions ?? []) : [] };
      } catch (error) {
        if (signal.aborted) throw new HttpFailure(504, 'El análisis de emociones tardó demasiado');
        const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
        if (name === 'InvalidImageFormatException' || name === 'ImageTooLargeException') {
          throw new HttpFailure(415, 'La imagen debe ser JPEG o PNG válida');
        }
        if (name === 'ThrottlingException' || name === 'ProvisionedThroughputExceededException') {
          throw new HttpFailure(429, 'Demasiados análisis; inténtalo en unos segundos', '5');
        }
        console.error(JSON.stringify({ service: 'library-service', event: 'rekognition_failed', name }));
        throw new HttpFailure(502, 'El servicio de análisis de emociones no está disponible');
      }
    }
  };
}
