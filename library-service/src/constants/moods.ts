export const DEFAULT_MOODS = [
  { code: "HAPPY", name: "Felicidad" },
  { code: "SAD", name: "Tristeza" },
  { code: "ANGRY", name: "Enojo" },
  { code: "FEAR", name: "Miedo" },
  { code: "DISGUSTED", name: "Desagrado" },
  { code: "SURPRISED", name: "Sorpresa" },
  { code: "CALM", name: "Neutralidad / calma" },
] as const;

export type MoodCode = (typeof DEFAULT_MOODS)[number]["code"];
