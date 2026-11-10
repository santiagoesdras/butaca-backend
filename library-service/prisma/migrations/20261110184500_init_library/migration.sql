-- ==========================================================
-- BUTACA DATABASE INITIAL MIGRATION
-- Schema: library (Totalmente sincronizado con Prisma + db.md)
-- ==========================================================

-- 1. CREACIÓN DEL ESQUEMA
CREATE SCHEMA IF NOT EXISTS "library";

-- 2. TIPOS ENUMERADOS
DO $$ BEGIN
    CREATE TYPE "library"."media_type" AS ENUM ('MOVIE', 'TV');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "library"."progress_status" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'ON_HOLD', 'DROPPED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. CREACIÓN DE TABLAS

-- library.profiles
CREATE TABLE IF NOT EXISTS "library"."profiles" (
    "id" UUID NOT NULL,
    "display_name" VARCHAR(120),
    "avatar_url" VARCHAR(500),
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- library.moods
CREATE TABLE IF NOT EXISTS "library"."moods" (
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "moods_pkey" PRIMARY KEY ("code")
);

-- library.mood_history
CREATE TABLE IF NOT EXISTS "library"."mood_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "primary_mood_code" VARCHAR(20) NOT NULL,
    "detection_date" DATE NOT NULL,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" VARCHAR(30) NOT NULL DEFAULT 'AWS_REKOGNITION',

    CONSTRAINT "mood_history_pkey" PRIMARY KEY ("id")
);

-- library.mood_history_scores
CREATE TABLE IF NOT EXISTS "library"."mood_history_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mood_history_id" UUID NOT NULL,
    "mood_code" VARCHAR(20) NOT NULL,
    "confidence" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "mood_history_scores_pkey" PRIMARY KEY ("id")
);

-- library.favorites
CREATE TABLE IF NOT EXISTS "library"."favorites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "media_type" "library"."media_type" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- library.watchlist_items
CREATE TABLE IF NOT EXISTS "library"."watchlist_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "media_type" "library"."media_type" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- library.progress
CREATE TABLE IF NOT EXISTS "library"."progress" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "media_type" "library"."media_type" NOT NULL,
    "status" "library"."progress_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "position_seconds" INTEGER,
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_pkey" PRIMARY KEY ("id")
);

-- library.progress_episodes
CREATE TABLE IF NOT EXISTS "library"."progress_episodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "progress_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "season_number" INTEGER NOT NULL,
    "episode_number" INTEGER NOT NULL,
    "watched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_episodes_pkey" PRIMARY KEY ("id")
);

-- library.saved_recommendations
CREATE TABLE IF NOT EXISTS "library"."saved_recommendations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "mood_history_id" UUID NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "media_type" "library"."media_type" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "poster_path" VARCHAR(500),
    "overview" TEXT,
    "release_date" VARCHAR(10),
    "vote_average" DECIMAL(3,1),
    "genre_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "mood_code_at_save" VARCHAR(20) NOT NULL,
    "mood_detected_at" TIMESTAMPTZ(6) NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_recommendations_pkey" PRIMARY KEY ("id")
);

-- library.camera_consents
CREATE TABLE IF NOT EXISTS "library"."camera_consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "policy_version" VARCHAR(50) NOT NULL,

    CONSTRAINT "camera_consents_pkey" PRIMARY KEY ("id")
);

-- 4. ÍNDICES Y LLAVES ÚNICAS (Coincidentes con @@unique y @@index en Prisma)

CREATE INDEX IF NOT EXISTS "mood_history_profile_detected_at_idx" ON "library"."mood_history"("profile_id", "detected_at");
CREATE UNIQUE INDEX IF NOT EXISTS "mood_history_profile_date_key" ON "library"."mood_history"("profile_id", "detection_date");
CREATE UNIQUE INDEX IF NOT EXISTS "mood_history_id_profile_key" ON "library"."mood_history"("id", "profile_id");

CREATE UNIQUE INDEX IF NOT EXISTS "mood_history_scores_history_mood_key" ON "library"."mood_history_scores"("mood_history_id", "mood_code");

CREATE INDEX IF NOT EXISTS "favorites_profile_created_at_idx" ON "library"."favorites"("profile_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "favorites_profile_tmdb_media_key" ON "library"."favorites"("profile_id", "tmdb_id", "media_type");

CREATE INDEX IF NOT EXISTS "watchlist_items_profile_created_at_idx" ON "library"."watchlist_items"("profile_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "watchlist_items_profile_tmdb_media_key" ON "library"."watchlist_items"("profile_id", "tmdb_id", "media_type");

CREATE INDEX IF NOT EXISTS "progress_profile_status_idx" ON "library"."progress"("profile_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "progress_profile_tmdb_media_key" ON "library"."progress"("profile_id", "tmdb_id", "media_type");
CREATE UNIQUE INDEX IF NOT EXISTS "progress_id_profile_key" ON "library"."progress"("id", "profile_id");

CREATE INDEX IF NOT EXISTS "progress_episodes_profile_watched_at_idx" ON "library"."progress_episodes"("profile_id", "watched_at");
CREATE UNIQUE INDEX IF NOT EXISTS "progress_episodes_progress_season_episode_key" ON "library"."progress_episodes"("progress_id", "season_number", "episode_number");

CREATE INDEX IF NOT EXISTS "saved_recommendations_profile_saved_at_idx" ON "library"."saved_recommendations"("profile_id", "saved_at");
CREATE UNIQUE INDEX IF NOT EXISTS "saved_recommendations_history_tmdb_media_key" ON "library"."saved_recommendations"("mood_history_id", "tmdb_id", "media_type");

CREATE UNIQUE INDEX IF NOT EXISTS "camera_consents_profile_id_key" ON "library"."camera_consents"("profile_id");

-- 5. LLAVES FORÁNEAS DE PRISMA

ALTER TABLE "library"."mood_history" 
    DROP CONSTRAINT IF EXISTS "mood_history_profile_id_fkey",
    ADD CONSTRAINT "mood_history_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "library"."profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library"."mood_history" 
    DROP CONSTRAINT IF EXISTS "mood_history_primary_mood_code_fkey",
    ADD CONSTRAINT "mood_history_primary_mood_code_fkey" FOREIGN KEY ("primary_mood_code") REFERENCES "library"."moods"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "library"."mood_history_scores" 
    DROP CONSTRAINT IF EXISTS "mood_history_scores_mood_history_id_fkey",
    ADD CONSTRAINT "mood_history_scores_mood_history_id_fkey" FOREIGN KEY ("mood_history_id") REFERENCES "library"."mood_history"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library"."mood_history_scores" 
    DROP CONSTRAINT IF EXISTS "mood_history_scores_mood_code_fkey",
    ADD CONSTRAINT "mood_history_scores_mood_code_fkey" FOREIGN KEY ("mood_code") REFERENCES "library"."moods"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "library"."favorites" 
    DROP CONSTRAINT IF EXISTS "favorites_profile_id_fkey",
    ADD CONSTRAINT "favorites_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "library"."profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library"."watchlist_items" 
    DROP CONSTRAINT IF EXISTS "watchlist_items_profile_id_fkey",
    ADD CONSTRAINT "watchlist_items_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "library"."profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library"."progress" 
    DROP CONSTRAINT IF EXISTS "progress_profile_id_fkey",
    ADD CONSTRAINT "progress_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "library"."profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library"."progress_episodes" 
    DROP CONSTRAINT IF EXISTS "progress_episodes_progress_id_profile_id_fkey",
    ADD CONSTRAINT "progress_episodes_progress_id_profile_id_fkey" FOREIGN KEY ("progress_id", "profile_id") REFERENCES "library"."progress"("id", "profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library"."saved_recommendations" 
    DROP CONSTRAINT IF EXISTS "saved_recommendations_profile_id_fkey",
    ADD CONSTRAINT "saved_recommendations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "library"."profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library"."saved_recommendations" 
    DROP CONSTRAINT IF EXISTS "saved_recommendations_mood_history_id_profile_id_fkey",
    ADD CONSTRAINT "saved_recommendations_mood_history_id_profile_id_fkey" FOREIGN KEY ("mood_history_id", "profile_id") REFERENCES "library"."mood_history"("id", "profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library"."saved_recommendations" 
    DROP CONSTRAINT IF EXISTS "saved_recommendations_mood_code_at_save_fkey",
    ADD CONSTRAINT "saved_recommendations_mood_code_at_save_fkey" FOREIGN KEY ("mood_code_at_save") REFERENCES "library"."moods"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "library"."camera_consents" 
    DROP CONSTRAINT IF EXISTS "camera_consents_profile_id_fkey",
    ADD CONSTRAINT "camera_consents_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "library"."profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. VÍNCULO CON SUPABASE AUTH (auth.users) Y TRIGGER DE PERFILES

DO $$ BEGIN
    ALTER TABLE "library"."profiles"
    ADD CONSTRAINT "profiles_id_auth_users_fkey"
    FOREIGN KEY ("id")
    REFERENCES auth.users("id")
    ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE OR REPLACE FUNCTION public.handle_new_butaca_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO library.profiles (
    id,
    display_name,
    avatar_url,
    time_zone
  )
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data ->> 'full_name',
      NEW.raw_user_meta_data ->> 'name'
    ),
    NEW.raw_user_meta_data ->> 'avatar_url',
    'UTC'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_butaca ON auth.users;

CREATE TRIGGER on_auth_user_created_butaca
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_butaca_user();

-- 7. RESTRICCIONES SQL CHECK (Validación de datos en motor)

DO $$ BEGIN
    ALTER TABLE library.mood_history_scores
    ADD CONSTRAINT mood_history_scores_confidence_range
    CHECK (confidence >= 0 AND confidence <= 100);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.favorites
    ADD CONSTRAINT favorites_tmdb_id_positive
    CHECK (tmdb_id > 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.watchlist_items
    ADD CONSTRAINT watchlist_items_tmdb_id_positive
    CHECK (tmdb_id > 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.progress
    ADD CONSTRAINT progress_tmdb_id_positive
    CHECK (tmdb_id > 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.progress
    ADD CONSTRAINT progress_position_nonnegative
    CHECK (position_seconds IS NULL OR position_seconds >= 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.progress
    ADD CONSTRAINT progress_duration_positive
    CHECK (duration_seconds IS NULL OR duration_seconds > 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.progress
    ADD CONSTRAINT progress_position_within_duration
    CHECK (
      position_seconds IS NULL
      OR duration_seconds IS NULL
      OR position_seconds <= duration_seconds
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.progress_episodes
    ADD CONSTRAINT progress_episodes_season_nonnegative
    CHECK (season_number >= 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.progress_episodes
    ADD CONSTRAINT progress_episodes_episode_positive
    CHECK (episode_number > 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.saved_recommendations
    ADD CONSTRAINT saved_recommendations_tmdb_id_positive
    CHECK (tmdb_id > 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE library.saved_recommendations
    ADD CONSTRAINT saved_recommendations_vote_average_range
    CHECK (
      vote_average IS NULL
      OR (vote_average >= 0 AND vote_average <= 10)
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 8. ROW LEVEL SECURITY (RLS) Y POLÍTICAS DE SEGURIDAD

ALTER TABLE library.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.moods ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.mood_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.mood_history_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.watchlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.progress_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.saved_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.camera_consents ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA library TO authenticated;
GRANT SELECT ON library.moods TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  library.profiles,
  library.mood_history,
  library.mood_history_scores,
  library.favorites,
  library.watchlist_items,
  library.progress,
  library.progress_episodes,
  library.saved_recommendations,
  library.camera_consents
TO authenticated;

-- Políticas de Profile
DROP POLICY IF EXISTS profiles_select_own ON library.profiles;
CREATE POLICY profiles_select_own ON library.profiles FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS profiles_insert_own ON library.profiles;
CREATE POLICY profiles_insert_own ON library.profiles FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS profiles_update_own ON library.profiles;
CREATE POLICY profiles_update_own ON library.profiles FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = id)
WITH CHECK ((SELECT auth.uid()) = id);

-- Políticas por profile_id
DROP POLICY IF EXISTS mood_history_own ON library.mood_history;
CREATE POLICY mood_history_own ON library.mood_history FOR ALL TO authenticated
USING ((SELECT auth.uid()) = profile_id)
WITH CHECK ((SELECT auth.uid()) = profile_id);

DROP POLICY IF EXISTS favorites_own ON library.favorites;
CREATE POLICY favorites_own ON library.favorites FOR ALL TO authenticated
USING ((SELECT auth.uid()) = profile_id)
WITH CHECK ((SELECT auth.uid()) = profile_id);

DROP POLICY IF EXISTS watchlist_items_own ON library.watchlist_items;
CREATE POLICY watchlist_items_own ON library.watchlist_items FOR ALL TO authenticated
USING ((SELECT auth.uid()) = profile_id)
WITH CHECK ((SELECT auth.uid()) = profile_id);

DROP POLICY IF EXISTS progress_own ON library.progress;
CREATE POLICY progress_own ON library.progress FOR ALL TO authenticated
USING ((SELECT auth.uid()) = profile_id)
WITH CHECK ((SELECT auth.uid()) = profile_id);

DROP POLICY IF EXISTS progress_episodes_own ON library.progress_episodes;
CREATE POLICY progress_episodes_own ON library.progress_episodes FOR ALL TO authenticated
USING ((SELECT auth.uid()) = profile_id)
WITH CHECK (
  (SELECT auth.uid()) = profile_id
  AND EXISTS (
    SELECT 1 FROM library.progress p
    WHERE p.id = progress_id
      AND p.profile_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS camera_consents_own ON library.camera_consents;
CREATE POLICY camera_consents_own ON library.camera_consents FOR ALL TO authenticated
USING ((SELECT auth.uid()) = profile_id)
WITH CHECK ((SELECT auth.uid()) = profile_id);

DROP POLICY IF EXISTS moods_read_authenticated ON library.moods;
CREATE POLICY moods_read_authenticated ON library.moods FOR SELECT TO authenticated
USING (true);

DROP POLICY IF EXISTS mood_history_scores_own ON library.mood_history_scores;
CREATE POLICY mood_history_scores_own ON library.mood_history_scores FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM library.mood_history mh
    WHERE mh.id = mood_history_id
      AND mh.profile_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM library.mood_history mh
    WHERE mh.id = mood_history_id
      AND mh.profile_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS saved_recommendations_own ON library.saved_recommendations;
CREATE POLICY saved_recommendations_own ON library.saved_recommendations FOR ALL TO authenticated
USING ((SELECT auth.uid()) = profile_id)
WITH CHECK (
  (SELECT auth.uid()) = profile_id
  AND EXISTS (
    SELECT 1 FROM library.mood_history mh
    WHERE mh.id = mood_history_id
      AND mh.profile_id = (SELECT auth.uid())
  )
);

-- 9. SEED DE EMOCIONES (Idempotente)
INSERT INTO "library"."moods" ("code", "name") VALUES
  ('HAPPY', 'Felicidad'),
  ('SAD', 'Tristeza'),
  ('ANGRY', 'Enojo'),
  ('FEAR', 'Miedo'),
  ('DISGUSTED', 'Desagrado'),
  ('SURPRISED', 'Sorpresa'),
  ('CALM', 'Neutralidad / calma')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name";
