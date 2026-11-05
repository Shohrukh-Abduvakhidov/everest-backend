import * as authRepository from '../repositories/auth-repository.js'
import * as testRepository from '../repositories/test-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { parsePagination, parseText, validateBody, validationError } from './course-service.js'

const testStatuses = ['draft', 'published', 'archived']
const assignmentStatuses = ['active', 'revoked', 'closed']
const testModes = ['lesson', 'practice', 'exam']
const resultPolicies = ['first', 'best', 'last']
const revealPolicies = ['after_submission', 'after_window', 'never']
const settingFields = [
   'title',
   'mode',
   'timeLimitMinutes',
   'maxAttempts',
   'resultPolicy',
   'answerRevealPolicy',
   'shuffleQuestions',
   'shuffleOptions',
   'passPercent',
]
const assignmentFields = ['groupId', 'userId', 'opensAt', 'closesAt', 'personalWindowMinutes']
const maximumTitleLength = 200
const maximumTimeLimitMinutes = 1440
const maximumAttempts = 1000
const maximumPersonalWindowMinutes = 525600
const maximumQuestionsPerRequest = 100
const maximumQuestionsPerTest = 500
const defaultPoints = '1'
const copySuffix = ' (copy)'
const pointsPattern = /^(?!0+(\.0+)?$)[0-9]{1,4}(\.[0-9]{1,2})?$/
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/
const defaultSettings = {
   mode: 'practice',
   timeLimitMinutes: null,
   maxAttempts: 1,
   resultPolicy: 'first',
   answerRevealPolicy: 'after_submission',
   shuffleQuestions: false,
   shuffleOptions: false,
   passPercent: null,
}

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || testRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function parseId(value, code, message) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, code, message)
   }
}

function parseTestId(value) {
   return parseId(value, 'INVALID_TEST_ID', 'Test identifier is invalid')
}

function parseQuestionId(value) {
   return parseId(value, 'INVALID_QUESTION_ID', 'Question identifier is invalid')
}

function parseAssignmentId(value) {
   return parseId(value, 'INVALID_ASSIGNMENT_ID', 'Assignment identifier is invalid')
}

function parseFieldId(value, field) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw validationError(field)
   }
}

function parseEnum(value, field, allowed) {
   if (!allowed.includes(value)) throw validationError(field)
   return value
}

function parseOptionalQueryEnum(value, field, allowed) {
   return value === undefined ? null : parseEnum(value, field, allowed)
}

function parseBoolean(value, field) {
   if (typeof value !== 'boolean') throw validationError(field)
   return value
}

function parseOptionalInteger(value, field, maximum) {
   if (value === null) return null
   if (!Number.isInteger(value) || value < 1 || value > maximum) throw validationError(field)
   return value
}

function parsePassPercent(value) {
   if (value === null) return null
   if (typeof value !== 'number' || !(value >= 0 && value <= 100)) throw validationError('passPercent')
   return value
}

function parsePoints(value, field = 'points') {
   if (typeof value !== 'string' && typeof value !== 'number') throw validationError(field)
   const points = String(value)
   if (!pointsPattern.test(points)) throw validationError(field)
   return points
}

function parseTimestamp(value, field) {
   if (typeof value !== 'string' || !isoTimestampPattern.test(value)) throw validationError(field)
   const parsed = new Date(value)
   if (Number.isNaN(parsed.getTime())) throw validationError(field)
   return parsed
}

function testNotFound() {
   return new AppError(404, 'TEST_NOT_FOUND', 'Test was not found')
}

function testQuestionNotFound() {
   return new AppError(404, 'TEST_QUESTION_NOT_FOUND', 'Question is not part of this test')
}

function assignmentNotFound() {
   return new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment was not found')
}

function requireDraft(test) {
   if (test.status !== 'draft') {
      throw new AppError(409, 'TEST_IMMUTABLE', 'Published and archived tests cannot be changed; create a copy')
   }
}

function requireCourseNotArchived(status) {
   if (status === 'archived') throw new AppError(409, 'COURSE_ARCHIVED', 'Course is archived')
}

function requirePublished(test) {
   if (test.status !== 'published') {
      throw new AppError(409, 'TEST_NOT_PUBLISHED', 'Only published tests can be assigned')
   }
}

function requireWindow(test, opensAt, closesAt) {
   if (closesAt !== null && closesAt <= opensAt) {
      throw validationError('closesAt', 'closesAt must be later than opensAt')
   }
   if (test.answer_reveal_policy === 'after_window' && closesAt === null) {
      throw validationError('closesAt', 'This test reveals results after the window, so it needs closesAt')
   }
}

function requireNoLinkedLessons(lessons) {
   if (!lessons.length) return
   throw new AppError(409, 'TEST_LINKED_TO_LESSON', 'A lesson uses this test; change the lesson first', lessons.map((lesson) => ({
      field: 'lessonId',
      message: lesson.id,
   })))
}

async function parseModuleForCourse(repository, value, courseId, client) {
   if (value === null) return null
   const moduleId = parseFieldId(value, 'moduleId')
   if (!(await repository.courseHasModule(courseId, moduleId, client))) {
      throw validationError('moduleId', 'moduleId must be a module of the test course')
   }
   return moduleId
}

function currentSettings(row) {
   return {
      title: row.title,
      mode: row.mode,
      timeLimitMinutes: row.duration_seconds === null ? null : row.duration_seconds / 60,
      maxAttempts: row.max_attempts,
      resultPolicy: row.result_policy,
      answerRevealPolicy: row.answer_reveal_policy,
      shuffleQuestions: row.shuffle_questions,
      shuffleOptions: row.shuffle_options,
      passPercent: row.grading_policy.passPercent ?? null,
   }
}

function mergeSettings(base, body) {
   const settings = { ...base }
   if ('title' in body) settings.title = parseText(body.title, 'title', maximumTitleLength)
   if ('mode' in body) settings.mode = parseEnum(body.mode, 'mode', testModes)
   if ('timeLimitMinutes' in body) {
      settings.timeLimitMinutes = parseOptionalInteger(
         body.timeLimitMinutes,
         'timeLimitMinutes',
         maximumTimeLimitMinutes,
      )
   }
   if ('maxAttempts' in body) {
      settings.maxAttempts = parseOptionalInteger(body.maxAttempts, 'maxAttempts', maximumAttempts)
   }
   if ('resultPolicy' in body) {
      settings.resultPolicy = parseEnum(body.resultPolicy, 'resultPolicy', resultPolicies)
   }
   if ('answerRevealPolicy' in body) {
      settings.answerRevealPolicy = parseEnum(body.answerRevealPolicy, 'answerRevealPolicy', revealPolicies)
   }
   if ('shuffleQuestions' in body) {
      settings.shuffleQuestions = parseBoolean(body.shuffleQuestions, 'shuffleQuestions')
   }
   if ('shuffleOptions' in body) {
      settings.shuffleOptions = parseBoolean(body.shuffleOptions, 'shuffleOptions')
   }
   if ('passPercent' in body) settings.passPercent = parsePassPercent(body.passPercent)
   if (settings.mode === 'exam' && settings.timeLimitMinutes === null) {
      throw validationError('timeLimitMinutes', 'An exam needs a time limit')
   }
   return settings
}

function persistedSettings(settings, gradingPolicy = {}) {
   const { passPercent: _previous, ...policy } = gradingPolicy
   return {
      title: settings.title,
      mode: settings.mode,
      durationSeconds: settings.timeLimitMinutes === null ? null : settings.timeLimitMinutes * 60,
      maxAttempts: settings.maxAttempts,
      resultPolicy: settings.resultPolicy,
      answerRevealPolicy: settings.answerRevealPolicy,
      shuffleQuestions: settings.shuffleQuestions,
      shuffleOptions: settings.shuffleOptions,
      gradingPolicy: settings.passPercent === null
         ? policy
         : { ...policy, passPercent: settings.passPercent },
   }
}

function safeTest(row) {
   return {
      id: row.id,
      courseId: row.course_id,
      moduleId: row.module_id,
      ...currentSettings(row),
      status: row.status,
      questionCount: row.question_count,
      totalPoints: row.total_points,
      activeAssignmentCount: row.active_assignment_count,
      copiedFromId: row.copied_from_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
   }
}

function safeTestQuestion(row) {
   return {
      questionId: row.question_id,
      bankId: row.bank_id,
      position: row.position,
      points: row.points,
      questionType: row.question_type,
      languageCode: row.language_code,
      status: row.status,
      keyStatus: row.key_status,
      content: row.content,
   }
}

function safeAssignment(row) {
   return {
      id: row.id,
      testId: row.test_id,
      audienceType: row.group_id ? 'group' : 'user',
      groupId: row.group_id,
      groupTitle: row.group_title,
      userId: row.user_id,
      userDisplayName: row.user_display_name,
      status: row.status,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      personalWindowMinutes: row.personal_window_minutes,
      assignedBy: row.assigned_by,
      createdAt: row.created_at,
   }
}

async function audit(auth, client, actorId, code, entityType, entityId, metadata = {}, subjectUserId = null) {
   await auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId,
      code,
      entityType,
      entityId,
      metadata,
   }, client)
}

async function readDetail(repository, actorId, testId, db) {
   const row = await repository.findTest(actorId, testId, db)
   return {
      ...safeTest(row),
      questions: (await repository.listTestQuestions(testId, db)).map(safeTestQuestion),
   }
}

async function loadTest(repository, client, actorId, testId) {
   const test = await repository.lockTest(actorId, testId, client)
   if (!test) throw testNotFound()
   return test
}

async function listTestsService(userId, query = {}, overrides) {
   const { repository } = dependencies(overrides)
   validateBody(query, ['limit', 'offset', 'courseId', 'status'])
   const filters = {
      ...parsePagination(query),
      courseId: query.courseId === undefined ? null : parseFieldId(query.courseId, 'courseId'),
      status: parseOptionalQueryEnum(query.status, 'status', testStatuses),
   }
   const rows = await repository.listTests(normalizeInternalId(userId), filters)
   return {
      tests: rows.slice(0, filters.limit).map(safeTest),
      pagination: {
         limit: filters.limit,
         offset: filters.offset,
         hasMore: rows.length > filters.limit,
      },
   }
}

async function getTestService(userId, testIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   if (!(await repository.findTest(actorId, testId))) throw testNotFound()
   return readDetail(repository, actorId, testId)
}

async function createTestService(userId, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   validateBody(body, ['courseId', 'moduleId', ...settingFields])
   const courseId = parseFieldId(body.courseId, 'courseId')
   if (!('title' in body)) throw validationError('title')
   const settings = mergeSettings(defaultSettings, body)
   return transaction(async (client) => {
      const course = await repository.lockManageableCourse(actorId, courseId, client)
      if (!course) throw new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
      requireCourseNotArchived(course.status)
      const moduleId = body.moduleId === undefined
         ? null
         : await parseModuleForCourse(repository, body.moduleId, courseId, client)
      const testId = await repository.createTest({
         ...persistedSettings(settings),
         moduleId,
         courseId,
         createdBy: actorId,
      }, client)
      await audit(auth, client, actorId, 'test.created', 'test', testId, { courseId })
      return readDetail(repository, actorId, testId, client)
   })
}

async function updateTestService(userId, testIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   validateBody(body, ['moduleId', ...settingFields])
   if (!Object.keys(body).length) throw validationError('body')
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      requireDraft(test)
      const settings = mergeSettings(currentSettings(test), body)
      const moduleId = body.moduleId === undefined
         ? test.module_id
         : await parseModuleForCourse(repository, body.moduleId, test.course_id, client)
      await repository.updateTest(testId, { ...persistedSettings(settings, test.grading_policy), moduleId }, client)
      await audit(auth, client, actorId, 'test.updated', 'test', testId, { fields: Object.keys(body) })
      return readDetail(repository, actorId, testId, client)
   })
}

async function deleteTestService(userId, testIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      requireDraft(test)
      if (await repository.hasCopies(testId, client)) {
         throw new AppError(409, 'TEST_HAS_COPIES', 'A test that has copies cannot be deleted')
      }
      requireNoLinkedLessons(await repository.listLinkedLessons(testId, { publishedOnly: false }, client))
      await repository.deleteDraftTest(testId, client)
      await audit(auth, client, actorId, 'test.deleted', 'test', testId, { title: test.title })
      return { id: testId, status: 'deleted' }
   })
}

async function addTestQuestionsService(userId, testIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   validateBody(body, ['questions'])
   if (
      !Array.isArray(body.questions)
      || !body.questions.length
      || body.questions.length > maximumQuestionsPerRequest
   ) {
      throw validationError('questions')
   }
   const questions = body.questions.map((item, index) => {
      validateBody(item, ['questionId', 'points'])
      return {
         questionId: parseFieldId(item.questionId, `questions[${index}].questionId`),
         points: item.points === undefined
            ? defaultPoints
            : parsePoints(item.points, `questions[${index}].points`),
      }
   })
   const questionIds = questions.map((question) => question.questionId)
   if (new Set(questionIds).size !== questionIds.length) throw validationError('questions', 'Questions repeat')
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      requireDraft(test)
      const existing = new Set(await repository.findTestQuestionIds(testId, client))
      if (questionIds.some((questionId) => existing.has(questionId))) {
         throw new AppError(409, 'TEST_QUESTION_DUPLICATE', 'Question is already in this test')
      }
      if (existing.size + questionIds.length > maximumQuestionsPerTest) {
         throw new AppError(409, 'TEST_QUESTION_LIMIT', `A test holds at most ${maximumQuestionsPerTest} questions`)
      }
      const readable = await repository.lockReadableQuestions(actorId, questionIds, client)
      if (readable.length !== questionIds.length) {
         throw new AppError(404, 'QUESTION_NOT_FOUND', 'Question was not found')
      }
      const ineligible = readable.find((question) => (
         question.status !== 'published' || question.key_status !== 'verified'
      ))
      if (ineligible) {
         throw new AppError(409, 'QUESTION_NOT_ELIGIBLE', 'Only published questions with a verified key can be added', [
            { field: 'questionId', message: ineligible.id },
         ])
      }
      await repository.addTestQuestions(testId, questions, client)
      await audit(auth, client, actorId, 'test.questions_added', 'test', testId, { questionIds })
      return readDetail(repository, actorId, testId, client)
   })
}

async function removeTestQuestionService(userId, testIdValue, questionIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const questionId = parseQuestionId(questionIdValue)
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      requireDraft(test)
      if (!(await repository.removeTestQuestion(testId, questionId, client))) throw testQuestionNotFound()
      const remaining = await repository.findTestQuestionIds(testId, client)
      if (remaining.length) await repository.setTestQuestionOrder(testId, remaining, client)
      await audit(auth, client, actorId, 'test.question_removed', 'test', testId, { questionId })
      return readDetail(repository, actorId, testId, client)
   })
}

async function reorderTestQuestionsService(userId, testIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   validateBody(body, ['questionIds'])
   if (!Array.isArray(body.questionIds) || !body.questionIds.length) throw validationError('questionIds')
   const questionIds = body.questionIds.map((value) => parseFieldId(value, 'questionIds'))
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      requireDraft(test)
      const current = await repository.findTestQuestionIds(testId, client)
      const requested = new Set(questionIds)
      if (
         requested.size !== questionIds.length
         || questionIds.length !== current.length
         || current.some((questionId) => !requested.has(questionId))
      ) {
         throw validationError('questionIds', 'questionIds must list every question of the test once')
      }
      await repository.setTestQuestionOrder(testId, questionIds, client)
      await audit(auth, client, actorId, 'test.questions_reordered', 'test', testId, {})
      return readDetail(repository, actorId, testId, client)
   })
}

async function updateTestQuestionPointsService(userId, testIdValue, questionIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const questionId = parseQuestionId(questionIdValue)
   validateBody(body, ['points'])
   const points = parsePoints(body.points)
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      requireDraft(test)
      if (!(await repository.setTestQuestionPoints(testId, questionId, points, client))) {
         throw testQuestionNotFound()
      }
      await audit(auth, client, actorId, 'test.question_points_changed', 'test', testId, { questionId, points })
      return readDetail(repository, actorId, testId, client)
   })
}

async function publishTestService(userId, testIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      if (test.status !== 'draft') {
         throw new AppError(409, 'INVALID_TEST_TRANSITION', 'Only draft tests can be published')
      }
      requireCourseNotArchived(test.course_status)
      const notReady = (message) => new AppError(409, 'TEST_NOT_PUBLISHABLE', 'Test is not ready for publication', [
         { field: 'test', message },
      ])
      if (!test.question_count) throw notReady('TEST_HAS_NO_QUESTIONS')
      const blocked = await repository.findUnpublishableQuestions(testId, client)
      if (blocked.length) throw notReady(`QUESTIONS_NOT_ELIGIBLE: ${blocked.join(', ')}`)
      await repository.setTestStatus(testId, 'published', client)
      await audit(auth, client, actorId, 'test.published', 'test', testId, {})
      return readDetail(repository, actorId, testId, client)
   })
}

async function archiveTestService(userId, testIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      if (test.status !== 'published') {
         throw new AppError(409, 'INVALID_TEST_TRANSITION', 'Only published tests can be archived')
      }
      requireNoLinkedLessons(await repository.listLinkedLessons(testId, { publishedOnly: true }, client))
      await repository.setTestStatus(testId, 'archived', client)
      await audit(auth, client, actorId, 'test.archived', 'test', testId, {})
      return readDetail(repository, actorId, testId, client)
   })
}

async function copyTestService(userId, testIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      requireCourseNotArchived(test.course_status)
      const title = `${test.title.slice(0, maximumTitleLength - copySuffix.length)}${copySuffix}`
      const copyId = await repository.copyTest(testId, title, actorId, client)
      await audit(auth, client, actorId, 'test.copied', 'test', copyId, { sourceTestId: testId })
      return readDetail(repository, actorId, copyId, client)
   })
}

async function listAssignmentsService(userId, testIdValue, query = {}, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   validateBody(query, ['limit', 'offset', 'status'])
   const filters = {
      ...parsePagination(query),
      status: parseOptionalQueryEnum(query.status, 'status', assignmentStatuses),
   }
   if (!(await repository.findTest(actorId, testId))) throw testNotFound()
   const rows = await repository.listAssignments(testId, filters)
   return {
      assignments: rows.slice(0, filters.limit).map(safeAssignment),
      pagination: {
         limit: filters.limit,
         offset: filters.offset,
         hasMore: rows.length > filters.limit,
      },
   }
}

async function createAssignmentService(userId, testIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   validateBody(body, assignmentFields)
   const hasGroup = body.groupId !== undefined
   if (hasGroup === (body.userId !== undefined)) {
      throw validationError('audience', 'Send exactly one of groupId and userId')
   }
   const audience = {
      groupId: hasGroup ? parseFieldId(body.groupId, 'groupId') : null,
      userId: hasGroup ? null : parseFieldId(body.userId, 'userId'),
   }
   const now = new Date()
   const opensAt = body.opensAt === undefined ? now : parseTimestamp(body.opensAt, 'opensAt')
   const closesAt = body.closesAt === undefined || body.closesAt === null
      ? null
      : parseTimestamp(body.closesAt, 'closesAt')
   if (closesAt !== null && closesAt <= now) {
      throw validationError('closesAt', 'closesAt must be in the future')
   }
   const personalWindowMinutes = body.personalWindowMinutes === undefined
      ? null
      : parseOptionalInteger(body.personalWindowMinutes, 'personalWindowMinutes', maximumPersonalWindowMinutes)
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      requirePublished(test)
      requireCourseNotArchived(test.course_status)
      requireWindow(test, opensAt, closesAt)
      if (hasGroup) {
         const group = await repository.lockAssignableGroup(actorId, audience.groupId, client)
         if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group was not found')
         if (group.status !== 'active') throw new AppError(409, 'GROUP_ARCHIVED', 'Group is archived')
      } else {
         const student = await repository.findAssignableStudent(audience.userId, test.course_id, client)
         if (!student) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
         if (student.status !== 'active' || !student.enrolled) {
            throw new AppError(409, 'STUDENT_NOT_ENROLLED', 'Student has no current enrollment in this course')
         }
      }
      if (await repository.hasActiveAssignment(testId, audience, client)) {
         throw new AppError(409, 'ASSIGNMENT_DUPLICATE', 'This audience already has an active assignment')
      }
      const assignmentId = await repository.createAssignment({
         ...audience,
         testId,
         assignedBy: actorId,
         opensAt,
         closesAt,
         personalWindowMinutes,
      }, client)
      await audit(auth, client, actorId, 'test.assignment_created', 'test_assignment', assignmentId, {
         testId,
         groupId: audience.groupId,
      }, audience.userId)
      return safeAssignment(await repository.findAssignment(testId, assignmentId, client))
   })
}

async function updateAssignmentService(userId, testIdValue, assignmentIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const assignmentId = parseAssignmentId(assignmentIdValue)
   validateBody(body, ['opensAt', 'closesAt', 'personalWindowMinutes'])
   if (!Object.keys(body).length) throw validationError('body')
   return transaction(async (client) => {
      const test = await loadTest(repository, client, actorId, testId)
      const assignment = await repository.findAssignment(testId, assignmentId, client)
      if (!assignment) throw assignmentNotFound()
      if (assignment.status !== 'active') {
         throw new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', 'Only active assignments can be changed')
      }
      requirePublished(test)
      const opensAt = body.opensAt === undefined ? assignment.opens_at : parseTimestamp(body.opensAt, 'opensAt')
      let closesAt = assignment.closes_at
      if (body.closesAt !== undefined) {
         closesAt = body.closesAt === null ? null : parseTimestamp(body.closesAt, 'closesAt')
      }
      requireWindow(test, opensAt, closesAt)
      const personalWindowMinutes = body.personalWindowMinutes === undefined
         ? assignment.personal_window_minutes
         : parseOptionalInteger(body.personalWindowMinutes, 'personalWindowMinutes', maximumPersonalWindowMinutes)
      await repository.updateAssignmentWindow(assignmentId, { opensAt, closesAt, personalWindowMinutes }, client)
      await audit(auth, client, actorId, 'test.assignment_updated', 'test_assignment', assignmentId, {
         testId,
         fields: Object.keys(body),
      }, assignment.user_id)
      return safeAssignment(await repository.findAssignment(testId, assignmentId, client))
   })
}

async function revokeAssignmentService(userId, testIdValue, assignmentIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const assignmentId = parseAssignmentId(assignmentIdValue)
   return transaction(async (client) => {
      await loadTest(repository, client, actorId, testId)
      const assignment = await repository.findAssignment(testId, assignmentId, client)
      if (!assignment) throw assignmentNotFound()
      if (assignment.status !== 'active') {
         throw new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', 'Only active assignments can be revoked')
      }
      await repository.revokeAssignment(assignmentId, client)
      await audit(auth, client, actorId, 'test.assignment_revoked', 'test_assignment', assignmentId, {
         testId,
      }, assignment.user_id)
      return { id: assignmentId, status: 'revoked' }
   })
}

export {
   addTestQuestionsService,
   archiveTestService,
   copyTestService,
   createAssignmentService,
   createTestService,
   deleteTestService,
   getTestService,
   listAssignmentsService,
   listTestsService,
   publishTestService,
   removeTestQuestionService,
   reorderTestQuestionsService,
   revokeAssignmentService,
   updateAssignmentService,
   updateTestQuestionPointsService,
   updateTestService,
}
