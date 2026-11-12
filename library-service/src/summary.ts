import { DEFAULT_MOODS, type MoodCode } from './constants/moods.js';
import type { HistoryEntry, SavedRecommendation } from './emotions.js';

export type SummaryPeriod = '7d' | '30d' | 'year';

const NAMES = new Map<string, string>(DEFAULT_MOODS.map(mood => [mood.code, mood.name]));
const CODES = DEFAULT_MOODS.map(mood => mood.code) as MoodCode[];
const emptyCounts = () => Object.fromEntries(CODES.map(code => [code, 0])) as Record<MoodCode, number>;
const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Agrega el historial para el tablero: distribución y emoción predominante, evolución en el tiempo
 * (por día en 7d/30d y por mes en year) y qué contenido se recomendó (por emoción, género y tipo).
 * `from` y `to` son días locales del usuario a medianoche UTC, como los devuelve historyRange.
 */
export function summarize(entries: HistoryEntry[], period: SummaryPeriod, from: Date, to: Date) {
  const counts = emptyCounts();
  for (const entry of entries) counts[entry.mood] = (counts[entry.mood] ?? 0) + 1;

  const distribution = CODES.map(mood => ({ mood, name: NAMES.get(mood)!, count: counts[mood] }));
  const top = [...distribution].sort((a, b) => b.count - a.count)[0]!;

  // Evolución: un punto por día (7d/30d) o por mes (year), incluidos los vacíos, para graficar sin huecos.
  const keyOf = (date: string) => period === 'year' ? date.slice(0, 7) : date;
  const buckets = new Map<string, Record<MoodCode, number>>();
  if (period === 'year') {
    const year = day(from).slice(0, 4);
    for (let month = 1; month <= 12; month++) buckets.set(`${year}-${String(month).padStart(2, '0')}`, emptyCounts());
  } else {
    for (let time = from.getTime(); time <= to.getTime(); time += 86400000) buckets.set(day(new Date(time)), emptyCounts());
  }
  for (const entry of entries) {
    const bucket = buckets.get(keyOf(entry.date));
    if (bucket) bucket[entry.mood] += 1;
  }

  const saved: (SavedRecommendation & { mood: MoodCode; mood_name: string; date: string })[] =
    entries.flatMap(entry => entry.recommendations.map(rec => ({ ...rec, mood: entry.mood, mood_name: entry.name, date: entry.date })));
  const byMood = emptyCounts();
  const byGenre = new Map<number, number>();
  const byType = { movie: 0, tv: 0 };
  for (const rec of saved) {
    byMood[rec.mood] += 1;
    byType[rec.media_type] += 1;
    for (const genre of rec.genre_ids) byGenre.set(genre, (byGenre.get(genre) ?? 0) + 1);
  }

  return {
    period,
    from: day(from),
    to: day(to),
    total_records: entries.length,
    days_with_records: new Set(entries.map(entry => entry.date)).size,
    predominant: top.count > 0 ? top : null,
    distribution,
    timeline: [...buckets].map(([bucket, moods]) => ({ bucket, counts: moods })),
    recommendations: {
      total: saved.length,
      by_media_type: byType,
      by_mood: CODES.map(mood => ({ mood, name: NAMES.get(mood)!, count: byMood[mood] })),
      // Los nombres de los géneros se obtienen de GET /api/v1/media/genres en el idioma del usuario.
      by_genre: [...byGenre].map(([genre_id, count]) => ({ genre_id, count })).sort((a, b) => b.count - a.count || a.genre_id - b.genre_id).slice(0, 10),
      recent: saved.sort((a, b) => b.saved_at.localeCompare(a.saved_at)).slice(0, 5)
    }
  };
}
