import express, { type ErrorRequestHandler, type Express } from 'express';

export class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: string) {
    super(message);
  }
}

export function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Configuración inválida: ' + name);
  return value;
}

export function service(name: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const start = performance.now();
    res.on('finish', () => console.log(JSON.stringify({
      service: name, method: req.method, route: req.route?.path ?? 'unmatched',
      status: res.statusCode, ms: Math.round(performance.now() - start)
    })));
    next();
  });
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

export function finish(app: Express) {
  app.use((_req, res) => res.status(404).json({ error: 'Ruta desconocida' }));
  const errors: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const failure = err instanceof HttpFailure ? err : new HttpFailure(500, 'Error interno');
    if (failure.retryAfter) res.set('Retry-After', failure.retryAfter);
    res.status(failure.status).json({ error: failure.message });
  };
  app.use(errors);
  return app;
}

// Conserva el mensaje `error` de los servicios internos; los formatos de terceros se ocultan.
async function errorMessage(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  const message = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
  return typeof message === 'string' && message.length > 0 && message.length <= 200 ? message : 'Error del proveedor';
}

export async function upstream(url: URL, timeout: number, headers?: HeadersInit) {
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(url, { signal, headers, redirect: 'error' });
    if (!response.ok) {
      const retry = response.headers.get('retry-after') ?? '';
      throw new HttpFailure(response.status, await errorMessage(response), /^\d{1,9}$/.test(retry) ? retry : undefined);
    }
    const data: unknown = await response.json();
    return data;
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure(signal.aborted ? 504 : 502, signal.aborted ? 'Tiempo de espera agotado' : 'Proveedor no disponible');
  }
}
