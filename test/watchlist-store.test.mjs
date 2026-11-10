import test from 'node:test';
import assert from 'node:assert/strict';
import { watchlistStore } from '../dist/library-service/src/watchlist.js';

test('Watchlist Prisma: usuario en lecturas, escritura y borrado; estado del progreso', async () => {
  const user = '11111111-1111-4111-8111-111111111111';
  const date = new Date('2026-11-10T12:00:00Z');
  const identity = { profileId: user, tmdbId: 42, mediaType: 'MOVIE' };
  const item = { tmdbId: 42, mediaType: 'MOVIE', createdAt: date };
  let status = 'COMPLETED';
  const calls = [];
  const tx = {
    watchlistItem: {
      async findMany(args) { calls.push(['list', args]); return [item]; },
      async createMany(args) { calls.push(['create', args]); return { count: 1 }; },
      async findUniqueOrThrow(args) { calls.push(['find', args]); return item; },
      async deleteMany(args) { calls.push(['delete', args]); return { count: 0 }; }
    },
    progress: {
      async findMany(args) { calls.push(['progressList', args]); return status ? [{ ...identity, status }] : []; },
      async findUnique(args) { calls.push(['progressOne', args]); return status ? { status } : null; }
    }
  };
  const db = { ...tx, $transaction: async input => typeof input === 'function' ? input(tx) : Promise.all(input) };
  const store = watchlistStore(db);
  const ref = { tmdb_id: 42, media_type: 'movie' };
  const expected = { ...ref, created_at: date.toISOString(), status: 'completed' };
  assert.deepEqual(await store.list(user), [expected]);
  assert.deepEqual(await store.add(user, ref), expected);
  await store.remove(user, ref);
  for (const [operation, args] of calls) {
    if (operation === 'create') {
      assert.deepEqual(args.data, identity);
      assert.equal(args.skipDuplicates, true, 'duplicados concurrentes se resuelven en PostgreSQL');
    } else if (operation === 'find' || operation === 'progressOne') {
      assert.deepEqual(args.where.profileId_tmdbId_mediaType, identity);
    } else {
      assert.equal(args.where.profileId, user, `${operation} debe filtrar por el usuario`);
      if (operation === 'delete') assert.deepEqual(args.where, identity);
    }
  }
  status = undefined;
  assert.equal((await store.list(user))[0].status, 'pending');
  assert.equal((await store.add(user, ref)).status, 'pending');
});
