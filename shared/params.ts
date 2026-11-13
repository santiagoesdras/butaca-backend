import { z } from 'zod';
import { parse } from './validate.js';

export type Query = Record<string, unknown>;
export type MediaType = 'movie' | 'tv';

/** Identificador de TMDB o de base de datos: entero 1..2147483647 sin ceros iniciales. */
export const tmdbIdText = (message: string) =>
  z.string({ error: message }).regex(/^[1-9]\d{0,9}$/, message).refine(value => Number(value) <= 2147483647, message).transform(Number);

export const mediaTypeSchema = z.enum(['movie', 'tv'], { error: 'media_type debe ser movie o tv' });

/** Rechaza parámetros de consulta no previstos. */
export function only(query: Query, allowed: string[]) {
  const unknown = Object.keys(query).filter(key => !allowed.includes(key));
  if (unknown.length) parse(z.never({ error: 'Parámetros no admitidos: ' + unknown.join(', ') }), unknown);
}

/**
 * Un parámetro de consulta opcional que, si aparece, debe ser texto único (Express entrega un arreglo
 * cuando se repite). El esquema `inner` valida su formato y define el valor predeterminado.
 */
function param<T extends z.ZodType<unknown, string | undefined>>(name: string, inner: T) {
  return z.union([z.undefined(), z.string()], { error: `El parámetro ${name} debe enviarse una sola vez` }).pipe(inner);
}

const languageSchema = param('language', z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'language debe tener formato es-MX').default('es-MX'));
const pageSchema = param('page', z.string().regex(/^[1-9]\d{0,2}$/, 'page debe ser un entero entre 1 y 500').default('1')
  .transform(Number).refine(value => value <= 500, 'page debe ser un entero entre 1 y 500'));
const searchSchema = param('query', z.string().default('').transform(value => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'query es obligatorio y admite hasta 100 caracteres').max(100, 'query es obligatorio y admite hasta 100 caracteres')));

export const language = (query: Query) => parse(languageSchema, query.language);
export const page = (query: Query) => parse(pageSchema, query.page);
export const searchText = (query: Query) => parse(searchSchema, query.query);

export function choice<T extends string>(query: Query, name: string, allowed: readonly T[], fallback: T): T {
  const values = allowed as unknown as [T, ...T[]];
  return parse(param(name, z.enum(values, { error: `${name} debe ser ${allowed.join(', ')}` }).default(fallback as never)), query[name]) as T;
}

export function limit(query: Query, max: number, fallback: number) {
  const message = `limit debe ser un entero entre 1 y ${max}`;
  return parse(param('limit', z.string().regex(/^[1-9]\d{0,2}$/, message).default(String(fallback))
    .transform(Number).refine(value => value <= max, message)), query.limit);
}

/** Valida los segmentos `/:media_type/:id` del detalle. */
export function mediaRef(params: Record<string, unknown>) {
  const { media_type, id } = parse(z.object({
    media_type: mediaTypeSchema,
    id: z.string({ error: 'id debe ser un entero positivo' }).regex(/^[1-9]\d{0,9}$/, 'id debe ser un entero positivo').transform(Number)
  }), params);
  return { type: media_type as MediaType, id };
}
