import type { z } from 'zod';
import { HttpFailure } from './http.js';

/**
 * Valida datos de una petición con un esquema de Zod. Si fallan, responde 400 con el mensaje del primer
 * problema (los esquemas definen mensajes en español pensados para el cliente). `status` permite usar
 * otro código cuando corresponde, por ejemplo 415 para un formato no admitido.
 */
export function parse<Schema extends z.ZodType>(schema: Schema, value: unknown, status = 400): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpFailure(status, result.error.issues[0]?.message ?? 'Datos inválidos');
}
