/**
 * Convierte un instante real de detección a la fecha local (medianoche UTC) 
 * correspondiente a la zona horaria del usuario (Profile.timeZone).
 *
 * Cumple con la especificación de Section C de db.md para garantizar
 * que exista una única detección diaria por usuario.
 */
export function dateInTimeZone(instant: Date, timeZone: string = "UTC"): Date {
  const safeTimeZone = timeZone && timeZone.trim().length > 0 ? timeZone : "UTC";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "01";

  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return new Date(`${date}T00:00:00.000Z`);
}
