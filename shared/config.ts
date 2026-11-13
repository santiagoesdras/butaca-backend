import { z } from 'zod';

/**
 * Lectura de variables de entorno con Zod. Cada servicio declara su esquema y lo valida al arrancar:
 * si falta una variable obligatoria o tiene un formato inválido, el proceso no inicia y el mensaje
 * indica qué variable revisar (sin mostrar su valor, para no filtrar secretos en los registros).
 */

// Docker Compose entrega `${VAR:-}` como cadena vacía: se trata igual que una variable ausente.
const blankAsMissing = (value: unknown) => typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Texto obligatorio no vacío (por ejemplo, un token). */
export const requiredText = z.preprocess(blankAsMissing, z.string({ error: 'es obligatoria' }).trim().min(1, 'es obligatoria'));

/** Texto opcional: vacío equivale a ausente. */
export const optionalText = z.preprocess(blankAsMissing, z.string().trim().min(1).optional());

/** Texto con valor predeterminado si la variable está vacía o ausente. */
export const textWithDefault = (fallback: string) => z.preprocess(blankAsMissing, z.string().trim().min(1).default(fallback));

const urlError = (issue: { input?: unknown }) => issue.input === undefined ? 'es obligatoria' : 'debe ser una URL http(s)';

/** URL http(s); con `fallback`, se usa ese valor si la variable no está definida. */
export function httpUrl(fallback?: string) {
  const url = z.url({ protocol: /^https?$/, error: urlError });
  return z.preprocess(blankAsMissing, fallback === undefined ? url : url.default(fallback));
}

export const optionalHttpUrl = z.preprocess(blankAsMissing, z.url({ protocol: /^https?$/, error: 'debe ser una URL http(s)' }).optional());

/** Cadena de conexión de PostgreSQL. */
export const postgresUrl = z.preprocess(blankAsMissing,
  z.string({ error: 'es obligatoria' }).regex(/^postgres(ql)?:\/\/\S+$/, 'debe ser una URL postgresql://'));

/** Entero positivo con valor predeterminado y máximo opcional. */
export function positiveInteger(fallback: number, max = Number.MAX_SAFE_INTEGER) {
  return z.preprocess(blankAsMissing,
    z.coerce.number({ error: 'debe ser un número' }).int('debe ser un entero').min(1, 'debe ser mayor que 0')
      .max(max, `debe ser como máximo ${max}`).default(fallback));
}

/** Interfaz de red donde escucha el servicio. */
export const bindHost = z.preprocess(blankAsMissing, z.string().default('127.0.0.1'));

/** Valida `env` con el esquema; lanza un error que lista cada variable inválida. */
export function loadConfig<Shape extends z.ZodRawShape>(shape: Shape, env: NodeJS.ProcessEnv = process.env) {
  const result = z.object(shape).safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error('Configuración inválida en el entorno:\n' + details);
  }
  return result.data;
}

/** Lee una sola variable numérica con Zod (para parámetros que se consultan al construir un servicio). */
export function envInteger(name: string, fallback: number, max?: number) {
  return loadConfig({ [name]: positiveInteger(fallback, max) })[name] as number;
}
