import { HttpFailure } from '../../shared/http.js';

export type Query = Record<string, unknown>;
export type MediaType = 'movie' | 'tv';

const invalid = (message: string) => new HttpFailure(400, message);

export function only(query: Query, allowed: string[]) {
  const unknown = Object.keys(query).filter(key => !allowed.includes(key));
  if (unknown.length) throw invalid('Parámetros no admitidos: ' + unknown.join(', '));
}

function text(query: Query, name: string) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`El parámetro ${name} debe enviarse una sola vez`);
  return value;
}

export function language(query: Query) {
  const value = text(query, 'language') ?? 'es-MX';
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(value)) throw invalid('language debe tener formato es-MX');
  return value;
}

export function page(query: Query) {
  const value = text(query, 'page') ?? '1';
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 500) throw invalid('page debe ser un entero entre 1 y 500');
  return Number(value);
}

export function choice<T extends string>(query: Query, name: string, allowed: readonly T[], fallback: T): T {
  const value = text(query, name) ?? fallback;
  if (!(allowed as readonly string[]).includes(value)) throw invalid(`${name} debe ser ${allowed.join(', ')}`);
  return value as T;
}

/** Valida los segmentos `/:media_type/:id` del detalle. */
export function mediaRef(params: Record<string, unknown>) {
  const type = params.media_type;
  const id = typeof params.id === 'string' ? params.id : '';
  if (type !== 'movie' && type !== 'tv') throw invalid('media_type debe ser movie o tv');
  if (!/^[1-9]\d{0,9}$/.test(id) || !Number.isSafeInteger(Number(id))) throw invalid('id debe ser un entero positivo');
  return { type: type as MediaType, id: Number(id) };
}

export function searchText(query: Query) {
  const value = text(query, 'query')?.trim().replace(/\s+/g, ' ') ?? '';
  if (value.length < 1 || value.length > 100) throw invalid('query es obligatorio y admite hasta 100 caracteres');
  return value;
}
