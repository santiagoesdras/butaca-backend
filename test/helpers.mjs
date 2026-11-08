import { createServer } from 'node:http';
import { once } from 'node:events';

export async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

/** Simula TMDB: `routes` asocia rutas como `/3/movie/popular` con funciones que reciben los searchParams. */
export function fakeTmdb(routes) {
  const calls = [];
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://tmdb');
    calls.push(url.pathname + url.search);
    if (req.headers.authorization !== 'Bearer prueba') return res.writeHead(401).end();
    const route = routes[url.pathname];
    if (!route) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"status_code":34}');
    const reply = route(url.searchParams);
    if (reply === undefined) return;
    if (typeof reply.status === 'number') return res.writeHead(reply.status, reply.headers ?? {}).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  };
  return { handler, calls };
}

export const summary = (overrides) => ({
  poster_path: null, overview: '', release_date: null, vote_average: null, genre_ids: [], ...overrides
});
