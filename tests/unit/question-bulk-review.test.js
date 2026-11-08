import assert from 'node:assert/strict'
import test from 'node:test'

import {
   classifyPublishState,
   classifyVerify,
   parseVerifyOptions,
} from '../../src/services/question-bulk-review-service.js'
import { parseExcludeDocument } from '../../src/utils/exclude-file.js'

function draft(overrides = {}) {
   return { id: 1, external_id: 'q1', status: 'draft', question_type: 'single_choice', ...overrides }
}

function parts(key) {
   return {
      options: [{ option_key: 'a' }, { option_key: 'b' }],
      matching: [],
      assetIds: [],
      answerKey: key,
   }
}

const settings = (overrides = {}) => parseVerifyOptions({ bankCode: 'bank', ...overrides })
const proposedKey = { status: 'proposed', source: 'official_key', answer_data: { optionKey: 'a' } }

test('verify options validate bank, batch size, source filter and exclude list', () => {
   assert.equal(settings().batchSize, 100)
   assert.throws(() => parseVerifyOptions({}), { code: 'VALIDATION_ERROR' })
   assert.throws(() => settings({ batchSize: 0 }), { code: 'VALIDATION_ERROR' })
   assert.throws(() => settings({ batchSize: 101 }), { code: 'VALIDATION_ERROR' })
   assert.throws(() => settings({ onlySource: 'guess' }), { code: 'VALIDATION_ERROR' })
   assert.throws(() => settings({ exclude: [''] }), { code: 'VALIDATION_ERROR' })
   assert.deepEqual([...settings({ exclude: [' q1 ', 'q2'] }).exclude], ['q1', 'q2'])
})

test('verify classification follows exclude, draft, proposed and source rules in order', () => {
   const base = settings({ exclude: ['q9'] })
   assert.equal(classifyVerify(draft({ external_id: 'q9' }), parts(proposedKey), base).code, 'SKIPPED_EXCLUDED')
   assert.equal(classifyVerify(draft({ status: 'published' }), parts(proposedKey), base).code, 'SKIPPED_NOT_DRAFT')
   assert.equal(classifyVerify(draft(), parts(null), base).code, 'SKIPPED_NOT_PROPOSED')
   assert.equal(classifyVerify(draft(), parts({ ...proposedKey, status: 'verified' }), base).code, 'SKIPPED_NOT_PROPOSED')
   assert.equal(
      classifyVerify(draft(), parts({ ...proposedKey, source: 'expert_review' }), settings({ onlySource: 'official_key' })).code,
      'SKIPPED_SOURCE_FILTERED',
   )
   assert.equal(classifyVerify(draft(), parts({ ...proposedKey, source: 'ai_inference' }), base).code, 'SKIPPED_SOURCE_NOT_VERIFIABLE')
   assert.deepEqual(
      classifyVerify(draft(), parts({ ...proposedKey, answer_data: { optionKey: 'z' } }), base),
      { code: 'FAILED', reason: 'ANSWER_KEY_INVALID' },
   )
   assert.deepEqual(classifyVerify(draft(), parts(proposedKey), base), { code: 'VERIFIED', keySource: 'official_key' })
})

test('publish classification only lets verified drafts through to the publication check', () => {
   assert.equal(classifyPublishState(draft({ status: 'published' }), parts(proposedKey)).code, 'SKIPPED_NOT_DRAFT')
   assert.equal(classifyPublishState(draft(), parts(proposedKey)).code, 'SKIPPED_KEY_NOT_VERIFIED')
   assert.equal(classifyPublishState(draft(), parts({ ...proposedKey, status: 'verified' })), null)
})

test('exclude files accept an array or { externalIds } and nothing else', () => {
   assert.deepEqual(parseExcludeDocument(['a', 'b', 'a']), ['a', 'b'])
   assert.deepEqual(parseExcludeDocument({ externalIds: [' c '] }), ['c'])
   for (const bad of [null, 'a', { ids: [] }, [1], ['']]) {
      assert.throws(() => parseExcludeDocument(bad), { code: 'EXCLUDE_FILE_INVALID' })
   }
})

test('a database error rolls the batch back, marks it FAILED and stops the run', async () => {
   const { bulkVerifyAnswerKeysService } = await import('../../src/services/question-bulk-review-service.js')
   const states = [1, 2, 3].map((id) => ({ id, external_id: `q${id}` }))
   const audits = []
   const overrides = {
      imports: {
         findActorById: async () => ({ id: 7, status: 'active' }),
         findBankByCode: async () => ({ id: 5, code: 'bank' }),
         listBankQuestionStates: async () => states,
      },
      authorization: { hasPermission: async (userId, code) => code === 'questions.review' },
      questions: {
         lockQuestion: async (id) => draft({ id, external_id: `q${id}` }),
         findQuestionParts: async () => parts(proposedKey),
      },
      auth: { appendAuditEvent: async (event) => audits.push(event.code) },
      transaction: async (work) => {
         const before = audits.length
         try {
            return await work({})
         } catch (error) {
            audits.length = before
            throw error
         }
      },
      verifyAnswerKey: async () => {
         throw Object.assign(new Error('connection lost'), { code: '08006' })
      },
      newRunId: () => 'run-1',
   }
   const result = await bulkVerifyAnswerKeysService('7', { bankCode: 'bank', batchSize: 2 }, overrides)
   assert.equal(result.status, 'failed')
   assert.deepEqual(result.entries.map((entry) => [entry.externalId, entry.outcome, entry.reason]), [
      ['q1', 'FAILED', 'BATCH_ROLLED_BACK'],
      ['q2', 'FAILED', 'BATCH_ROLLED_BACK'],
   ])
   assert.equal(result.counters.notAttempted, 1)
   assert.deepEqual(result.errors.map((entry) => entry.code), ['BULK_BATCH_FAILED'])
   assert.deepEqual(audits, [])
})
