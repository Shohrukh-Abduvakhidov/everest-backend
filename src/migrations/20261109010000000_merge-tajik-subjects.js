// Merges the duplicate Tajik-language subject created by the nct-tg-2026 bank import
// (code tajik_language) into the canonical subject zaboni-tochiki. Both are found by code;
// when either is missing the migration does nothing, so a repeated run is a no-op.
//
// Every row that points at the duplicate (banks, questions, question topics, sections, topics,
// courses) is moved in ONE statement: the composite (id, subject_id) foreign keys are checked
// at the end of that statement, after parents and children agree again. Moving a question
// to another subject does not change its content, but the immutability guards reject any
// column change on a published question, so those two guards are disabled for this
// transaction only and re-enabled before it commits.
//
// Missing translations and a non-neutral color move to the canonical subject; values the
// canonical subject already has are kept. Section or topic codes present in both subjects
// stop the migration, because merging two taxonomy entries needs a human decision.
//
// The down migration is a no-op: the merge is not reversible without the dropped id.
export const up = pgm => {
   pgm.sql(`
DO $$
DECLARE
   v_keep BIGINT;
   v_drop BIGINT;
   v_questions_before INTEGER;
   v_questions_after INTEGER;
   v_conflicts TEXT;
   v_ref RECORD;
   v_left INTEGER;
BEGIN
   SELECT id INTO v_keep FROM subjects WHERE code = 'zaboni-tochiki' FOR UPDATE;
   SELECT id INTO v_drop FROM subjects WHERE code = 'tajik_language' FOR UPDATE;
   IF v_keep IS NULL OR v_drop IS NULL THEN
      RAISE NOTICE 'merge-tajik-subjects: nothing to merge';
      RETURN;
   END IF;

   SELECT string_agg(kind || ' ' || code, ', ') INTO v_conflicts FROM (
      SELECT 'section' AS kind, code FROM sections WHERE subject_id = v_drop
         AND code IN (SELECT code FROM sections WHERE subject_id = v_keep)
      UNION ALL
      SELECT 'topic', code FROM topics WHERE subject_id = v_drop
         AND code IN (SELECT code FROM topics WHERE subject_id = v_keep)
   ) AS conflict;
   IF v_conflicts IS NOT NULL THEN
      RAISE EXCEPTION 'TAJIK_SUBJECT_MERGE_CONFLICT: codes exist in both subjects: %', v_conflicts;
   END IF;

   SELECT count(*) INTO v_questions_before FROM questions WHERE subject_id IN (v_keep, v_drop);

   INSERT INTO subject_translations (subject_id, language_code, title)
   SELECT v_keep, language_code, title FROM subject_translations WHERE subject_id = v_drop
   ON CONFLICT (subject_id, language_code) DO NOTHING;
   DELETE FROM subject_translations WHERE subject_id = v_drop;

   UPDATE subjects AS keep SET color = dropped.color
   FROM subjects AS dropped
   WHERE keep.id = v_keep AND dropped.id = v_drop
      AND keep.color = 'neutral' AND dropped.color <> 'neutral';

   ALTER TABLE questions DISABLE TRIGGER questions_guard;
   ALTER TABLE question_topics DISABLE TRIGGER question_topics_guard;

   WITH moved_banks AS (
      UPDATE question_banks SET subject_id = v_keep WHERE subject_id = v_drop RETURNING id
   ), moved_questions AS (
      UPDATE questions SET subject_id = v_keep WHERE subject_id = v_drop RETURNING id
   ), moved_question_topics AS (
      UPDATE question_topics SET subject_id = v_keep WHERE subject_id = v_drop RETURNING question_id
   ), moved_sections AS (
      UPDATE sections SET subject_id = v_keep WHERE subject_id = v_drop RETURNING id
   ), moved_topics AS (
      UPDATE topics SET subject_id = v_keep WHERE subject_id = v_drop RETURNING id
   ), moved_courses AS (
      UPDATE courses SET subject_id = v_keep WHERE subject_id = v_drop RETURNING id
   )
   SELECT 1 INTO v_left FROM (
      SELECT count(*) FROM moved_banks UNION ALL SELECT count(*) FROM moved_questions
      UNION ALL SELECT count(*) FROM moved_question_topics UNION ALL SELECT count(*) FROM moved_sections
      UNION ALL SELECT count(*) FROM moved_topics UNION ALL SELECT count(*) FROM moved_courses
   ) AS moved LIMIT 1;

   ALTER TABLE question_topics ENABLE TRIGGER question_topics_guard;
   ALTER TABLE questions ENABLE TRIGGER questions_guard;

   SELECT count(*) INTO v_questions_after FROM questions WHERE subject_id = v_keep;
   IF v_questions_after <> v_questions_before THEN
      RAISE EXCEPTION 'TAJIK_SUBJECT_MERGE_COUNT: % questions before, % after',
         v_questions_before, v_questions_after;
   END IF;

   -- Any column named subject_id, with or without a declared foreign key, must be clear.
   FOR v_ref IN
      SELECT c.table_name FROM information_schema.columns AS c
      JOIN information_schema.tables AS t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.column_name = 'subject_id'
   LOOP
      EXECUTE format('SELECT count(*) FROM %I WHERE subject_id = $1', v_ref.table_name)
         INTO v_left USING v_drop;
      IF v_left <> 0 THEN
         RAISE EXCEPTION 'TAJIK_SUBJECT_MERGE_LEFTOVER: % rows in % still use subject %',
            v_left, v_ref.table_name, v_drop;
      END IF;
   END LOOP;

   DELETE FROM subjects WHERE id = v_drop;
   RAISE NOTICE 'merge-tajik-subjects: moved subject % into %, % questions', v_drop, v_keep, v_questions_after;
END $$;
   `)
}

export const down = () => {}
