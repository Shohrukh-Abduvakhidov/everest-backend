// Shared loader for scripts/audit-question-text.js and scripts/fix-question-text.js.
// Maintenance SQL for operational scripts (AGENTS.md allows it outside src/repositories).

function groupByQuestion(rows) {
   const map = new Map()
   for (const row of rows) {
      if (!map.has(row.question_id)) map.set(row.question_id, [])
      map.get(row.question_id).push(row)
   }
   return map
}

// Every question of every bank (or of one bank) with its options, matching items and key.
// lock: true takes FOR UPDATE row locks (the fix script runs inside its write transaction).
async function loadQuestions(client, { bankCode = null, lock = false } = {}) {
   const forUpdate = lock ? 'FOR UPDATE' : ''
   const questions = await client.query(`
      SELECT q.id, q.external_id, q.question_type, q.language_code, q.status, q.content,
         b.code AS bank_code
      FROM questions q
      JOIN question_banks b ON b.id = q.bank_id
      WHERE $1::text IS NULL OR b.code = $1
      ORDER BY b.code, q.id
      ${lock ? 'FOR UPDATE OF q' : ''}
   `, [bankCode])
   const ids = questions.rows.map((row) => row.id)
   const keys = await client.query(`
      SELECT question_id, status, answer_data, explanation FROM question_answer_keys
      WHERE question_id = ANY($1::bigint[])
   `, [ids])
   const uses = await client.query(`
      SELECT question_id, count(*)::int AS attempt_uses FROM attempt_questions
      WHERE question_id = ANY($1::bigint[]) GROUP BY question_id
   `, [ids])
   const options = await client.query(`
      SELECT id, question_id, option_key, content FROM question_options
      WHERE question_id = ANY($1::bigint[]) ORDER BY question_id, position ${forUpdate}
   `, [ids])
   const matching = await client.query(`
      SELECT id, question_id, side, item_key, content FROM question_matching_items
      WHERE question_id = ANY($1::bigint[]) ORDER BY question_id, side, position ${forUpdate}
   `, [ids])
   const keyOf = new Map(keys.rows.map((row) => [row.question_id, row]))
   const usesOf = new Map(uses.rows.map((row) => [row.question_id, row.attempt_uses]))
   const optionsOf = groupByQuestion(options.rows)
   const matchingOf = groupByQuestion(matching.rows)
   return questions.rows.map((row) => {
      const key = keyOf.get(row.id)
      return {
         id: row.id,
         externalId: row.external_id,
         bankCode: row.bank_code,
         type: row.question_type,
         language: row.language_code,
         status: row.status,
         attemptUses: usesOf.get(row.id) ?? 0,
         content: row.content,
         options: (optionsOf.get(row.id) || []).map((option) => ({
            rowId: option.id,
            key: option.option_key,
            content: option.content,
         })),
         matching: (matchingOf.get(row.id) || []).map((item) => ({
            rowId: item.id,
            side: item.side,
            key: item.item_key,
            content: item.content,
         })),
         answerKey: key
            ? { status: key.status, answerData: key.answer_data, explanation: key.explanation }
            : null,
      }
   })
}

// Everything a text fix must leave unchanged: ids, keys, positions, labels, answer keys,
// test links, attempt orders and grading snapshots, student answers. Compared before and
// after the update inside the same transaction.
async function loadIntegritySnapshot(client, questionIds) {
   const { rows } = await client.query(`
      SELECT q.id, q.status, q.question_type, q.bank_id, q.external_id,
         (SELECT jsonb_agg(jsonb_build_array(o.id, o.option_key, o.position, o.source_label) ORDER BY o.id)
            FROM question_options o WHERE o.question_id = q.id) AS options,
         (SELECT jsonb_agg(jsonb_build_array(m.id, m.side, m.item_key, m.position, m.source_label) ORDER BY m.id)
            FROM question_matching_items m WHERE m.question_id = q.id) AS matching,
         (SELECT jsonb_build_array(k.status, k.source, k.answer_data, k.explanation, k.verified_at)
            FROM question_answer_keys k WHERE k.question_id = q.id) AS answer_key,
         (SELECT jsonb_agg(jsonb_build_array(t.id, t.test_id, t.position, t.points) ORDER BY t.id)
            FROM test_questions t WHERE t.question_id = q.id) AS test_links,
         (SELECT md5(coalesce(string_agg(jsonb_build_array(a.id, a.attempt_id, a.position, a.option_order,
               a.matching_order, a.max_points, a.grading_snapshot)::text, '|' ORDER BY a.id), ''))
            FROM attempt_questions a WHERE a.question_id = q.id) AS attempts,
         (SELECT md5(coalesce(string_agg(jsonb_build_array(s.attempt_question_id, s.answer_data,
               s.awarded_points, s.grading_status, s.revision)::text, '|' ORDER BY s.attempt_question_id), ''))
            FROM student_answers s WHERE s.question_id = q.id) AS answers
      FROM questions q
      WHERE q.id = ANY($1::bigint[])
      ORDER BY q.id
   `, [questionIds])
   return rows
}

export { loadIntegritySnapshot, loadQuestions }
