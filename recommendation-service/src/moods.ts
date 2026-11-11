/**
 * Reglas de emoción → géneros de TMDB (ids de películas; las series se relacionan mediante las
 * equivalencias del motor, por ejemplo 28 Acción ↔ 10759 Action & Adventure).
 *
 * Los códigos son los del catálogo `library.moods` (DEFAULT_MOODS de Library Service).
 * Criterio: con emociones negativas se busca acompañar y aligerar el ánimo, sin intensificarlo
 * (por ejemplo, no se sugiere terror a quien registró miedo); con emociones positivas o neutras se
 * refuerza el estado actual. Ajustar esta tabla no requiere cambiar el contrato HTTP.
 */
export const MOOD_GENRES = {
  HAPPY: [35, 12, 16, 10402, 10751],      // Comedia, Aventura, Animación, Música, Familia
  SAD: [35, 10751, 16, 10749, 10402],     // Comedia, Familia, Animación, Romance, Música
  ANGRY: [35, 16, 12, 10751],             // Comedia, Animación, Aventura, Familia
  FEAR: [35, 10751, 16, 14],              // Comedia, Familia, Animación, Fantasía
  DISGUSTED: [16, 35, 14, 99],            // Animación, Comedia, Fantasía, Documental
  SURPRISED: [9648, 878, 14, 53],         // Misterio, Ciencia ficción, Fantasía, Suspenso
  CALM: [18, 10749, 99, 36]               // Drama, Romance, Documental, Historia
} as const satisfies Record<string, readonly number[]>;

export type Mood = keyof typeof MOOD_GENRES;
export const MOODS = Object.keys(MOOD_GENRES) as Mood[];

/**
 * Géneros que se evitan para no intensificar una emoción negativa. Un candidato con alguno de ellos
 * conserva solo la mitad de su puntuación y no recibe el motivo `mood`.
 */
export const MOOD_AVOID: Partial<Record<Mood, readonly number[]>> = {
  SAD: [27, 10752],          // Terror, Bélica
  ANGRY: [27, 10752, 80],    // Terror, Bélica, Crimen
  FEAR: [27, 53],            // Terror, Suspenso
  DISGUSTED: [27]            // Terror
};
