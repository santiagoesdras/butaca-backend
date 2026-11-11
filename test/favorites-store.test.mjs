import test from 'node:test';
import assert from 'node:assert/strict';
import { favoritesStore } from '../dist/library-service/src/favorites.js';

test('Favoritos Prisma: usuario en lecturas, escritura y borrado', async () => {
  const user = '11111111-1111-4111-8111-111111111111';
  const date = new Date('2026-11-10T12:00:00Z');
  const identity = { profileId: user, tmdbId: 42, mediaType: 'TV' };
  const item = { tmdbId: 42, mediaType: 'TV', createdAt: date };
  const calls = [];
  const tx = {
    favorite: {
      async findMany(args) { calls.push(['list', args]); return [item]; },
      async createMany(args) { calls.push(['create', args]); return { count: 1 }; },
      async findUniqueOrThrow(args) { calls.push(['find', args]); return item; },
      async deleteMany(args) { calls.push(['delete', args]); return { count: 0 }; }
    }
  };
  const db = { ...tx, $transaction: async input => input(tx) };
  const store = favoritesStore(db);
  const ref = { tmdb_id: 42, media_type: 'tv' };
  const expected = { ...ref, created_at: date.toISOString() };

  assert.deepEqual(await store.list(user), [expected]);
  assert.deepEqual(await store.add(user, ref), expected);
  await store.remove(user, ref);
  assert.deepEqual(calls.map(([operation]) => operation), ['list', 'create', 'find', 'delete']);
  for (const [operation, args] of calls) {
    if (operation === 'create') {
      assert.deepEqual(args.data, identity);
      assert.equal(args.skipDuplicates, true, 'duplicados concurrentes se resuelven en PostgreSQL');
    } else if (operation === 'find') {
      assert.deepEqual(args.where.profileId_tmdbId_mediaType, identity);
    } else {
      assert.equal(args.where.profileId, user, `${operation} debe filtrar por el usuario`);
      if (operation === 'delete') assert.deepEqual(args.where, identity);
    }
  }
});
