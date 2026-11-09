import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { HttpFailure } from './http.js';

export type AuthConfig = {
  /** URL del proyecto, por ejemplo https://<ref>.supabase.co */
  supabaseUrl: string;
  audience?: string;
  algorithms?: ('ES256' | 'RS256')[];
  /** Solo para proyectos con el secreto JWT heredado (HS256). Sin él se usan las claves públicas (JWKS). */
  jwtSecret?: string;
};

export type User = { id: string; token: string };

const unauthorized = (message: string) => new HttpFailure(401, message);

// Errores que indican un token rechazado; el resto (red, JWKS inaccesible) es indisponibilidad.
const rejected = (error: unknown) => error instanceof errors.JOSEError &&
  (/^ERR_(JWT|JWS)_/.test(error.code) ||
    ['ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED', 'ERR_JWKS_NO_MATCHING_KEY',
      'ERR_JWKS_MULTIPLE_MATCHING_KEYS'].includes(error.code));

/** Verifica firma, emisor, audiencia y expiración de un access token de Supabase Auth. */
export function authenticator({ supabaseUrl, audience = 'authenticated', jwtSecret, algorithms = ['ES256', 'RS256'] }: AuthConfig) {
  const issuer = new URL('/auth/v1', supabaseUrl).href;
  const options = { issuer, audience, requiredClaims: ['sub', 'exp'] };
  const verify = jwtSecret
    ? (token: string) => jwtVerify(token, new TextEncoder().encode(jwtSecret), { ...options, algorithms: ['HS256'] })
    : (() => {
        const keys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'), { timeoutDuration: 3000 });
        return (token: string) => jwtVerify(token, keys, { ...options, algorithms });
      })();

  return async (authorization: string | undefined): Promise<User> => {
    const token = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(authorization ?? '')?.[1];
    if (!token) throw unauthorized('Se requiere Authorization: Bearer <access_token>');
    try {
      const { payload } = await verify(token);
      if (typeof payload.sub !== 'string' || !payload.sub) throw unauthorized('Token sin usuario');
      return { id: payload.sub, token };
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      if (rejected(error)) throw unauthorized('Token inválido o expirado');
      throw new HttpFailure(503, 'Autenticación no disponible');
    }
  };
}
