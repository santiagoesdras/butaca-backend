import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/library-service/generated/prisma/client.js';
import { watchlistStore } from '../dist/library-service/src/watchlist.js';
import { progressStore } from '../dist/library-service/src/progress.js';

const connectionString = process.env.LIBRARY_TEST_DATABASE_URL;
const profileId = process.env.LIBRARY_TEST_PROFILE_ID;

test('Library PostgreSQL: watchlist, progreso y episodios con rollback', {
  skip: !connectionString || !profileId,
  timeout: 25000
}, async () => {
  assert.match(profileId, /^[0-9a-f-]{36}$/i);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5000 }) });
  const rollback = new Error('ROLLBACK_LIBRARY_TEST');
  let verified = false;
  try {
    await db.$transaction(async tx => {
      assert.ok(await tx.profile.findUnique({ where: { id: profileId }, select: { id: true } }), 'Debe existir el perfil propio de prueba');
      let id = 2147483000;
      while (await tx.progress.count({ where: { profileId, tmdbId: id } }) || await tx.watchlistItem.count({ where: { profileId, tmdbId: id } })) id--;
      // Las operaciones del repositorio comparten esta transacción externa, que siempre se revierte.
      const scoped = { watchlistItem: tx.watchlistItem, progress: tx.progress, progressEpisode: tx.progressEpisode,
        $transaction: async operations => typeof operations === 'function' ? operations(tx) : Promise.all(operations) };
      const watchlist = watchlistStore(scoped), progress = progressStore(scoped);
      const ref = { tmdb_id: id, media_type: 'movie' }, series = { ...ref, media_type: 'tv' };
      const other = '00000000-0000-4000-8000-000000000000';
      assert.notEqual(profileId, other);
      const first = await watchlist.add(profileId, ref);
      assert.deepEqual(await watchlist.add(profileId, ref), first);
      assert.equal(await tx.watchlistItem.count({ where: { profileId, tmdbId: id } }), 1);
      await watchlist.remove(other, ref);
      assert.equal(await tx.watchlistItem.count({ where: { profileId, tmdbId: id } }), 1);
      await progress.set(profileId, ref, { status: 'in_progress', position_seconds: 30, duration_seconds: 100 });
      const completed = await progress.set(profileId, ref, { status: 'completed', position_seconds: 100, duration_seconds: 100 });
      assert.equal(completed.status, 'completed');
      assert.equal((await watchlist.list(profileId)).find(item => item.tmdb_id === id).status, 'completed');
      const episode = { season: 0, episode: 1 };
      const one = await progress.markEpisode(profileId, series, episode);
      const two = await progress.markEpisode(profileId, series, episode);
      assert.equal(two.episodes.length, 1);
      assert.equal(two.episodes[0].watched_at, one.episodes[0].watched_at);
      assert.equal(two.status, 'in_progress');
      assert.equal(await tx.progress.count({ where: { profileId, tmdbId: id } }), 2);
      const paused = await progress.set(profileId, series, { status: 'on_hold', position_seconds: null, duration_seconds: null });
      assert.equal(paused.episodes.length, 1);
      await progress.removeEpisode(other, series, episode);
      assert.equal((await progress.list(profileId)).find(item => item.tmdb_id === id && item.media_type === 'tv').episodes.length, 1);
      await progress.removeEpisode(profileId, series, episode);
      assert.equal((await progress.list(profileId)).find(item => item.tmdb_id === id && item.media_type === 'tv').episodes.length, 0);
      await watchlist.remove(profileId, ref);
      assert.equal(await tx.watchlistItem.count({ where: { profileId, tmdbId: id } }), 0);
      verified = true;
      throw rollback;
    }, { timeout: 15000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await db.$disconnect();
  }
  assert.equal(verified, true);
});
