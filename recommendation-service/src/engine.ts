import { MOOD_AVOID, MOOD_GENRES, type Mood } from './moods.js';
import { key, type Library, type Ref, type Summary } from './sources.js';

export type Reason = 'genres' | 'mood' | 'trending' | 'popular' | 'top_rated';
export type Recommendation = Summary & { score: number; reasons: Reason[] };

/** Pesos de las señales del usuario sobre sus géneros preferidos. */
export const WEIGHTS = { favorite: 3, seen: 2, watchlist: 1 } as const;
export const MAX_SEEDS = 20;

// Equivalencias entre géneros de series y de películas en TMDB (Action & Adventure ↔ Acción, Aventura, etc.).
const EQUIVALENT: [number, number[]][] = [[10759, [28, 12]], [10765, [878, 14]], [10768, [10752]], [10762, [10751]]];
const related = new Map<number, number[]>();
for (const [tv, movies] of EQUIVALENT) {
  related.set(tv, movies);
  for (const movie of movies) related.set(movie, [...(related.get(movie) ?? []), tv]);
}
const expand = (genres: number[]) => [...new Set(genres.flatMap(genre => [genre, ...(related.get(genre) ?? [])]))];

/** Títulos de la biblioteca que sirven para inferir gustos, con su peso, sin duplicados. */
export function seeds(library: Library): (Ref & { weight: number })[] {
  const ranked = [
    ...library.favorites.map(item => ({ ...item, weight: WEIGHTS.favorite })),
    ...[...library.progress, ...library.watchlist].map(item =>
      ({ ...item, weight: item.seen ? WEIGHTS.seen : WEIGHTS.watchlist }))
  ].sort((a, b) => b.weight - a.weight);
  const unique = new Map<string, Ref & { weight: number }>();
  for (const { media_type, id, weight } of ranked) {
    if (!unique.has(key({ media_type, id }))) unique.set(key({ media_type, id }), { media_type, id, weight });
  }
  return [...unique.values()].slice(0, MAX_SEEDS);
}

/**
 * Reglas:
 * 1. Se excluye todo lo que ya está en la biblioteca (favoritos, watchlist y progreso), incluido lo visto.
 * 2. Afinidad: suma de los pesos normalizados de los géneros del candidato que coinciden con los del usuario.
 * 3. Se combinan afinidad, posición en populares, calificación y presencia en tendencias.
 *    Sin señales del usuario (arranque en frío) solo cuentan popularidad, calificación y tendencias.
 * 4. Con una emoción, se suma la coincidencia con sus géneros (MOOD_GENRES) y pesa más que el historial.
 *    Los géneros de MOOD_AVOID reducen la puntuación a la mitad (por ejemplo, terror con miedo).
 */
export function rank(input: {
  seeds: { weight: number; genres: number[] }[];
  excluded: Set<string>;
  trending: Summary[];
  popular: Summary[][];
  mood?: Mood;
}): Recommendation[] {
  const moodGenres = new Set<number>(input.mood ? expand([...MOOD_GENRES[input.mood]]) : []);
  const avoided = new Set<number>(input.mood ? expand([...(MOOD_AVOID[input.mood] ?? [])]) : []);
  const weights = new Map<number, number>();
  for (const seed of input.seeds) {
    for (const genre of expand(seed.genres)) weights.set(genre, (weights.get(genre) ?? 0) + seed.weight);
  }
  const top = Math.max(0, ...weights.values());
  const personal = top > 0;

  const candidates = new Map<string, { item: Summary; popularity: number; trending: boolean; popular: boolean }>();
  const add = (list: Summary[], source: 'trending' | 'popular') => list.forEach((item, index) => {
    const id = key(item);
    if (input.excluded.has(id)) return;
    const entry = candidates.get(id) ?? { item, popularity: 0, trending: false, popular: false };
    entry.popularity = Math.max(entry.popularity, 1 - index / Math.max(list.length, 1));
    entry[source] = true;
    candidates.set(id, entry);
  });
  add(input.trending, 'trending');
  input.popular.forEach(list => add(list, 'popular'));

  return [...candidates.values()].map(({ item, popularity, trending, popular }) => {
    const genres = expand(item.genre_ids);
    const matched = genres.reduce((sum, genre) => sum + (weights.get(genre) ?? 0) / top, 0);
    const affinity = personal && item.genre_ids.length ? Math.min(1, matched / Math.sqrt(item.genre_ids.length)) : 0;
    const rating = (item.vote_average ?? 5) / 10;
    // Fracción de los géneros del candidato que corresponden a la emoción (0 sin emoción).
    const moodMatch = genres.length ? genres.filter(genre => moodGenres.has(genre)).length / genres.length : 0;
    const avoid = genres.some(genre => avoided.has(genre));
    const mood = avoid ? 0 : Math.min(1, moodMatch * 2);
    const trend = Number(trending);
    const score = (avoid ? 0.5 : 1) * (input.mood
      ? (personal
        ? 0.45 * mood + 0.3 * affinity + 0.1 * popularity + 0.1 * rating + 0.05 * trend
        : 0.55 * mood + 0.2 * popularity + 0.15 * rating + 0.1 * trend)
      : (personal
        ? 0.6 * affinity + 0.15 * popularity + 0.15 * rating + 0.1 * trend
        : 0.45 * popularity + 0.35 * rating + 0.2 * trend));
    const reasons: Reason[] = [];
    if (mood > 0) reasons.push('mood');
    if (affinity > 0) reasons.push('genres');
    if (trending) reasons.push('trending');
    if (popular) reasons.push('popular');
    if ((item.vote_average ?? 0) >= 7.5) reasons.push('top_rated');
    return { ...item, score: Math.round(score * 1000) / 1000, reasons };
  }).sort((a, b) => b.score - a.score);
}
