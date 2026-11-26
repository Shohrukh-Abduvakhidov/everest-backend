import env from '../configs/env.js'
import * as jobRepository from '../repositories/job-repository.js'
import * as notificationRepository from '../repositories/notification-repository.js'
import * as telegramDeliveryRepository from '../repositories/telegram-delivery-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import {
   notificationExpiresAt,
   renderNotification,
   telegramEventCodes,
} from '../utils/notification-texts.js'
import { quietUntil } from '../utils/quiet-hours.js'

// M14 (decisions.md 2026-11-21). Domain services call enqueue* inside their own transaction, so
// a rolled-back change leaves no job (outbox). worker:jobs runs notification.fanout later: it
// re-reads the current state, resolves recipients and writes one in-app notification per user.
// Three UNIQUE keys keep an event from arriving twice: background_jobs.dedupe_key,
// notifications (user_id, dedupe_key) and, from PR 2, the delivery per channel and destination.

const fanoutJobType = 'notification.fanout'
const insertBatchSize = 500

function dependencies(overrides = {}) {
   return {
      config: overrides.config || env,
      repository: overrides.repository || notificationRepository,
      deliveries: overrides.deliveries || telegramDeliveryRepository,
      jobs: overrides.jobs || jobRepository,
      transaction: overrides.transaction || withTransaction,
      now: overrides.now || (() => new Date()),
   }
}

// Telegram copies need a configured bot; without one nothing is queued for Telegram.
function telegramBotId(config) {
   const telegram = config.telegram || {}
   return telegram.clientId && telegram.botToken ? telegram.clientId : null
}

// One pending delivery per new notification whose recipient has Telegram on, the event on and an
// active connection. Inside quiet hours the delivery waits until they end (D5).
async function queueTelegramCopies(entry, inserted, context, client) {
   const { config, deliveries, now } = context
   const botId = telegramBotId(config)
   if (!botId || !inserted.length || !telegramEventCodes.includes(entry.eventCode)) return 0
   const notificationByUser = new Map(inserted.map((row) => [String(row.user_id), row.id]))
   const targets = await deliveries.findTelegramTargets([...notificationByUser.keys()], botId, entry.eventCode, client)
   const current = now()
   const expiresAt = notificationExpiresAt(entry.eventCode, entry.dedupeKey)
   const rows = targets
      .filter((target) => target.telegram_enabled && target.event_enabled)
      .map((target) => {
         const quietEnd = quietUntil(current, {
            start: target.quiet_start, end: target.quiet_end, timeZone: target.timezone,
         })
         const nextAttemptAt = quietEnd || current
         // D5: a reminder that would wait past its moment is not sent; the in-app copy stays.
         const expired = expiresAt && quietEnd && nextAttemptAt >= expiresAt
         return {
            notificationId: notificationByUser.get(String(target.user_id)),
            connectionId: target.connection_id,
            nextAttemptAt,
            ...(expired ? { status: 'cancelled', errorCode: 'QUIET_EXPIRED' } : {}),
         }
      })
   return deliveries.insertTelegramDeliveries(rows, client)
}

function id(value) {
   return normalizeInternalId(String(value))
}

function coursePath(courseId) {
   return courseId ? `/courses/${courseId}` : '/'
}

// Where a notification about an assignment leads: the course of a course test, the assignment
// itself for a test outside courses (origin standalone, 2026-11-22).
function testPath(row, assignmentId) {
   if (row.origin === 'standalone') return `/tests/assignments/${assignmentId}`
   return coursePath(row.course_id)
}

// Result pages of the student app for each kind of attempt.
function attemptResultPath(attempt) {
   if (attempt.origin === 'trainer') return `/nct/attempts/${attempt.id}/result`
   if (attempt.origin === 'mock_exam') return `/nct/exam/${attempt.id}/result`
   return `/tests/attempts/${attempt.id}/result`
}

// ---------------------------------------------------------------- enqueue (inside the caller's transaction)

async function enqueueFanout(client, { event, payload, dedupeKey, availableAt = null }, overrides) {
   const { jobs } = dependencies(overrides)
   return jobs.enqueueJob({
      jobType: fanoutJobType,
      payload: { event, ...payload },
      dedupeKey: `notify:${dedupeKey}`,
      availableAt,
   }, client)
}

// Fires at opens_at when the assignment opens later. The job key includes opens_at, so moving
// the opening time schedules a new job; the notification key stays per assignment.
function enqueueTestAssigned(client, { assignmentId, opensAt }, overrides) {
   const opens = opensAt ? new Date(opensAt) : new Date()
   return enqueueFanout(client, {
      event: 'test.assigned',
      payload: { assignmentId: id(assignmentId) },
      dedupeKey: `test.assigned:${id(assignmentId)}:${opens.toISOString()}`,
      availableAt: opens,
   }, overrides)
}

// A student who joins a group gets test.assigned for each open assignment of that group, with
// the same notification key as the group-wide event, so nobody gets it twice.
function enqueueGroupMemberJoined(client, { groupId, userId, auditId }, overrides) {
   return enqueueFanout(client, {
      event: 'group.member_joined',
      payload: { groupId: id(groupId), userId: id(userId) },
      dedupeKey: `group.member_joined:${id(groupId)}:${id(userId)}:${id(auditId)}`,
   }, overrides)
}

function enqueueGroupAnnouncement(client, { announcementId }, overrides) {
   return enqueueFanout(client, {
      event: 'group.announcement',
      payload: { announcementId: id(announcementId) },
      dedupeKey: `group.announcement:${id(announcementId)}`,
   }, overrides)
}

function enqueueExtraAttempts(client, { grantId }, overrides) {
   return enqueueFanout(client, {
      event: 'test.extra_attempts',
      payload: { grantId: id(grantId) },
      dedupeKey: `test.extra_attempts:${id(grantId)}`,
   }, overrides)
}

function enqueueAccountEvent(client, { event, userId, auditId }, overrides) {
   return enqueueFanout(client, {
      event,
      payload: { userId: id(userId), auditId: id(auditId) },
      dedupeKey: `${event}:${id(auditId)}`,
   }, overrides)
}

// A grant that begins later fires at begins_at.
function enqueueCourseEnrolled(client, { enrollmentId, auditId, beginsAt }, overrides) {
   return enqueueFanout(client, {
      event: 'course.enrolled',
      payload: { enrollmentId: id(enrollmentId), auditId: id(auditId) },
      dedupeKey: `course.enrolled:${id(enrollmentId)}:${id(auditId)}`,
      availableAt: beginsAt,
   }, overrides)
}

const dayMs = 24 * 3600 * 1000

// Close-time events of an assignment (M14 PR 3). Job and notification keys include the close
// time, so moving closes_at schedules new jobs and the old ones find a different close time and
// write nothing.
// - test.closing_24h at closes_at − 24 h, only when that moment is not in the past now (an
//   assignment created, or moved to close, less than 24 h ahead gets no reminder);
// - test.answers_available at closes_at, only for answer_reveal_policy after_window.
async function enqueueAssignmentCloseEvents(client, { assignmentId, closesAt, answerRevealPolicy, now = new Date() }, overrides) {
   if (!closesAt) return
   const closes = new Date(closesAt)
   const closesIso = closes.toISOString()
   const remindAt = new Date(closes.getTime() - dayMs)
   if (remindAt.getTime() >= now.getTime()) {
      await enqueueFanout(client, {
         event: 'test.closing_24h',
         payload: { assignmentId: id(assignmentId), closesAt: closesIso },
         dedupeKey: `test.closing_24h:${id(assignmentId)}:${closesIso}`,
         availableAt: remindAt,
      }, overrides)
   }
   if (answerRevealPolicy === 'after_window') {
      await enqueueFanout(client, {
         event: 'test.answers_available',
         payload: { assignmentId: id(assignmentId), closesAt: closesIso },
         dedupeKey: `test.answers_available:${id(assignmentId)}:${closesIso}`,
         availableAt: closes,
      }, overrides)
   }
}

// After a regrade that changed the score; the audit id makes every such regrade its own event.
function enqueueResultUpdated(client, { attemptId, auditId }, overrides) {
   return enqueueFanout(client, {
      event: 'test.result_updated',
      payload: { attemptId: id(attemptId), auditId: id(auditId) },
      dedupeKey: `test.result_updated:${id(attemptId)}:${id(auditId)}`,
   }, overrides)
}

// The timer closed the attempt (sweep, lazy expiry or a submit after the deadline).
function enqueueAttemptExpired(client, { attemptId }, overrides) {
   return enqueueFanout(client, {
      event: 'attempt.expired',
      payload: { attemptId: id(attemptId) },
      dedupeKey: `attempt.expired:${id(attemptId)}`,
   }, overrides)
}

function enqueueModuleOpened(client, { grantId, auditId, beginsAt }, overrides) {
   return enqueueFanout(client, {
      event: 'module.opened',
      payload: { grantId: id(grantId), auditId: id(auditId) },
      dedupeKey: `module.opened:${id(grantId)}:${id(auditId)}`,
      availableAt: beginsAt,
   }, overrides)
}

// A new achievement (M13). Keyed by user and achievement: an award exists once, so the
// notification does too.
function enqueueAchievementUnlocked(client, { userId, achievementId }, overrides) {
   return enqueueFanout(client, {
      event: 'achievement.unlocked',
      payload: { userId: id(userId), achievementId: id(achievementId) },
      dedupeKey: `achievement.unlocked:${id(userId)}:${id(achievementId)}`,
   }, overrides)
}

// ---------------------------------------------------------------- fanout resolvers

// Each resolver re-checks the source now and returns the notifications to write (one entry per
// distinct notification key), or [] when the event no longer applies.
async function resolveAssignment(repository, db, assignmentId, onlyUserId = null) {
   const assignment = await repository.findAssignmentSource(assignmentId, db)
   if (!assignment || assignment.status !== 'active' || assignment.test_status !== 'published'
      || !assignment.is_open || assignment.is_closed) return []
   let userIds = assignment.user_id
      ? [assignment.user_id]
      : await repository.listActiveGroupMemberIds(assignment.group_id, db)
   if (onlyUserId) userIds = userIds.filter((userId) => String(userId) === String(onlyUserId))
   return [{
      eventCode: 'test.assigned',
      userIds,
      params: { test: assignment.test_title, closesAt: assignment.closes_at },
      targetPath: testPath(assignment, assignment.id),
      dedupeKey: `test.assigned:${assignment.id}`,
   }]
}

const resolvers = {
   'test.assigned': (repository, payload, db) => resolveAssignment(repository, db, payload.assignmentId),

   async 'group.member_joined'(repository, payload, db) {
      if (!await repository.isActiveGroupMember(payload.groupId, payload.userId, db)) return []
      const assignmentIds = await repository.listOpenGroupAssignmentIds(payload.groupId, db)
      const entries = []
      for (const assignmentId of assignmentIds) {
         entries.push(...await resolveAssignment(repository, db, assignmentId, payload.userId))
      }
      return entries
   },

   async 'group.announcement'(repository, payload, db) {
      const announcement = await repository.findAnnouncementSource(payload.announcementId, db)
      if (!announcement || announcement.status !== 'published' || announcement.group_status !== 'active') return []
      const members = await repository.listActiveGroupMemberIds(announcement.group_id, db)
      return [{
         eventCode: 'group.announcement',
         userIds: members.filter((userId) => String(userId) !== String(announcement.author_id)),
         params: { group: announcement.group_title, title: announcement.title },
         targetPath: '/',
         dedupeKey: `group.announcement:${announcement.id}`,
      }]
   },

   async 'test.extra_attempts'(repository, payload, db) {
      const grant = await repository.findAttemptGrantSource(payload.grantId, db)
      if (!grant || grant.assignment_status !== 'active') return []
      return [{
         eventCode: 'test.extra_attempts',
         userIds: [grant.user_id],
         params: { test: grant.test_title, count: grant.extra_attempts },
         targetPath: testPath(grant, grant.assignment_id),
         dedupeKey: `test.extra_attempts:${grant.id}`,
      }]
   },

   'account.approved': (repository, payload) => [{
      eventCode: 'account.approved',
      userIds: [payload.userId],
      params: {},
      targetPath: '/',
      dedupeKey: `account.approved:${payload.auditId}`,
   }],

   'account.unblocked': (repository, payload) => [{
      eventCode: 'account.unblocked',
      userIds: [payload.userId],
      params: {},
      targetPath: '/',
      dedupeKey: `account.unblocked:${payload.auditId}`,
   }],

   async 'course.enrolled'(repository, payload, db) {
      const enrollment = await repository.findEnrollmentSource(payload.enrollmentId, db)
      if (!enrollment || !enrollment.is_current || enrollment.course_status !== 'published') return []
      return [{
         eventCode: 'course.enrolled',
         userIds: [enrollment.user_id],
         params: { course: enrollment.course_title },
         targetPath: coursePath(enrollment.course_id),
         dedupeKey: `course.enrolled:${enrollment.id}:${payload.auditId}`,
      }]
   },

   async 'test.closing_24h'(repository, payload, db) {
      const assignment = await repository.findAssignmentWindowSource(payload.assignmentId, db)
      if (!assignment || assignment.status !== 'active' || assignment.test_status !== 'published'
         || !assignment.closes_at || assignment.is_closed
         || new Date(assignment.closes_at).toISOString() !== payload.closesAt) return []
      const audience = assignment.user_id
         ? [assignment.user_id]
         : await repository.listActiveGroupMemberIds(assignment.group_id, db)
      return [{
         eventCode: 'test.closing_24h',
         userIds: await repository.filterUsersToRemind(assignment.id, assignment.max_attempts, audience, db),
         params: { test: assignment.test_title, closesAt: assignment.closes_at },
         targetPath: testPath(assignment, assignment.id),
         dedupeKey: `test.closing_24h:${assignment.id}:${payload.closesAt}`,
      }]
   },

   async 'test.answers_available'(repository, payload, db) {
      const assignment = await repository.findAssignmentWindowSource(payload.assignmentId, db)
      if (!assignment || assignment.status === 'revoked' || assignment.answer_reveal_policy !== 'after_window'
         || !assignment.closes_at || !assignment.is_closed
         || new Date(assignment.closes_at).toISOString() !== payload.closesAt) return []
      return [{
         eventCode: 'test.answers_available',
         userIds: await repository.listFinishedAttemptUserIds(assignment.id, db),
         params: { test: assignment.test_title },
         targetPath: testPath(assignment, assignment.id),
         dedupeKey: `test.answers_available:${assignment.id}:${payload.closesAt}`,
      }]
   },

   async 'test.result_updated'(repository, payload, db) {
      const attempt = await repository.findAttemptSource(payload.attemptId, db)
      if (!attempt || !['graded', 'expired'].includes(attempt.status)) return []
      return [{
         eventCode: 'test.result_updated',
         userIds: [attempt.user_id],
         params: { test: attempt.test_title },
         targetPath: attemptResultPath(attempt),
         dedupeKey: `test.result_updated:${attempt.id}:${payload.auditId}`,
      }]
   },

   async 'attempt.expired'(repository, payload, db) {
      const attempt = await repository.findAttemptSource(payload.attemptId, db)
      if (!attempt || attempt.status !== 'expired') return []
      return [{
         eventCode: 'attempt.expired',
         userIds: [attempt.user_id],
         params: { test: attempt.test_title },
         targetPath: attemptResultPath(attempt),
         dedupeKey: `attempt.expired:${attempt.id}`,
      }]
   },

   async 'achievement.unlocked'(repository, payload, db) {
      const award = await repository.findAchievementAwardSource(payload.userId, payload.achievementId, db)
      if (!award || !award.is_active) return []
      const titles = Object.fromEntries(Object.entries(award.translations ?? {})
         .map(([language, text]) => [language, text?.title ?? award.code]))
      return [{
         eventCode: 'achievement.unlocked',
         userIds: [award.user_id],
         params: { achievement: Object.keys(titles).length ? titles : { ru: award.code } },
         targetPath: '/achievements',
         dedupeKey: `achievement.unlocked:${award.id}`,
      }]
   },

   async 'module.opened'(repository, payload, db) {
      const grant = await repository.findModuleGrantSource(payload.grantId, db)
      if (!grant || !grant.is_current || grant.module_status !== 'published') return []
      return [{
         eventCode: 'module.opened',
         userIds: [grant.user_id],
         params: { module: grant.module_title, course: grant.course_title },
         targetPath: coursePath(grant.course_id),
         dedupeKey: `module.opened:${grant.id}:${payload.auditId}`,
      }]
   },
}

function permanentError(code) {
   const error = new Error(code)
   error.code = code
   error.permanent = true
   return error
}

// notification.fanout handler. Idempotent: running it again writes nothing new.
async function runNotificationFanoutService(payload, overrides) {
   const context = dependencies(overrides)
   const { repository, transaction } = context
   const resolver = resolvers[payload?.event]
   if (!resolver) throw permanentError('NOTIFICATION_EVENT_UNKNOWN')
   return transaction(async (client) => {
      const entries = await resolver(repository, payload, client)
      let created = 0
      let telegram = 0
      for (const entry of entries) {
         const recipients = await repository.findRecipients([...new Set(entry.userIds.map(String))], client)
         for (let start = 0; start < recipients.length; start += insertBatchSize) {
            const rows = recipients.slice(start, start + insertBatchSize).map((recipient) => ({
               userId: recipient.user_id,
               eventCode: entry.eventCode,
               targetPath: entry.targetPath,
               dedupeKey: entry.dedupeKey,
               ...renderNotification(entry.eventCode, entry.params, {
                  languageCode: recipient.language_code,
                  timeZone: recipient.timezone,
               }),
            }))
            const inserted = await repository.insertNotifications(rows, client)
            created += inserted.length
            telegram += await queueTelegramCopies(entry, inserted, context, client)
         }
      }
      return { created, telegram }
   })
}

// ---------------------------------------------------------------- retention (D3: 180 days)

const retentionJobType = 'notification.retention'
const retentionDays = 180
const retentionBatchSize = 1000

// Enqueued by worker:jobs at start and every hour; the date in the key makes it once a day.
async function scheduleNotificationRetentionService(overrides) {
   const { jobs, transaction, now } = dependencies(overrides)
   const day = now().toISOString().slice(0, 10)
   return transaction((client) => jobs.enqueueJob({
      jobType: retentionJobType,
      payload: { days: retentionDays },
      dedupeKey: `${retentionJobType}:${day}`,
   }, client))
}

// Deletes read and unread notifications older than the retention, with their deliveries, in
// batches (one transaction each, so a large backlog never holds long locks).
async function runNotificationRetentionService(payload, overrides) {
   const { repository, transaction } = dependencies(overrides)
   const days = Number.isSafeInteger(payload?.days) && payload.days >= 30 ? payload.days : retentionDays
   let deleted = 0
   for (;;) {
      const batch = await transaction((client) => repository.deleteOldNotifications(days, retentionBatchSize, client))
      deleted += batch
      if (batch < retentionBatchSize) return { deleted }
   }
}

function createNotificationJobHandlers(overrides) {
   return Object.freeze({
      [fanoutJobType]: (payload) => runNotificationFanoutService(payload, overrides),
      [retentionJobType]: (payload) => runNotificationRetentionService(payload, overrides),
   })
}

const notificationJobHandlers = createNotificationJobHandlers()

// ---------------------------------------------------------------- inbox

function validationError(field, message = `${field} is invalid`) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field, message }])
}

function parseNotificationId(value, field = 'notificationId') {
   try {
      return normalizeInternalId(value)
   } catch {
      if (field === 'notificationId') {
         throw new AppError(400, 'INVALID_NOTIFICATION_ID', 'Notification identifier is invalid')
      }
      throw validationError(field)
   }
}

function parseListQuery(query = {}) {
   const allowed = ['limit', 'before', 'unread']
   const unknown = Object.keys(query).find((key) => !allowed.includes(key))
   if (unknown) throw validationError(unknown, `${unknown} is not allowed`)
   let limit = 20
   if (query.limit !== undefined) {
      if (typeof query.limit !== 'string' || !/^[1-9][0-9]?$/.test(query.limit) || Number(query.limit) > 50) {
         throw validationError('limit', 'limit must be 1-50')
      }
      limit = Number(query.limit)
   }
   const beforeId = query.before === undefined ? null : parseNotificationId(query.before, 'before')
   if (query.unread !== undefined && query.unread !== 'true' && query.unread !== 'false') {
      throw validationError('unread', 'unread must be true or false')
   }
   return { limit, beforeId, unreadOnly: query.unread === 'true' }
}

function safeNotification(row) {
   return {
      id: String(row.id),
      eventCode: row.event_code,
      title: row.title,
      body: row.body,
      targetPath: row.target_path,
      createdAt: row.created_at,
      readAt: row.read_at,
   }
}

async function requireActiveAccount(repository, userId) {
   if (!await repository.isActiveAccount(userId)) {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
   }
}

async function listNotificationsService(userId, query, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const filters = parseListQuery(query || {})
   await requireActiveAccount(repository, actorId)
   const rows = await repository.listNotifications(actorId, filters)
   const page = rows.slice(0, filters.limit)
   const hasMore = rows.length > filters.limit
   return {
      notifications: page.map(safeNotification),
      pagination: {
         limit: filters.limit,
         hasMore,
         nextBefore: hasMore ? String(page.at(-1).id) : null,
      },
   }
}

async function countUnreadNotificationsService(userId, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   await requireActiveAccount(repository, actorId)
   return { count: await repository.countUnread(actorId) }
}

async function markNotificationReadService(userId, notificationIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const notificationId = parseNotificationId(notificationIdValue)
   await requireActiveAccount(repository, actorId)
   const row = await repository.markRead(actorId, notificationId)
   if (!row) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification was not found')
   return safeNotification(row)
}

// upToId is the newest notification the user has seen, so one that arrives during the request
// stays unread.
async function markAllNotificationsReadService(userId, body, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('body')
   const unknown = Object.keys(body).find((key) => key !== 'upToId')
   if (unknown) throw validationError(unknown, `${unknown} is not allowed`)
   if (body.upToId === undefined) throw validationError('upToId', 'upToId is required')
   const upToId = parseNotificationId(body.upToId, 'upToId')
   await requireActiveAccount(repository, actorId)
   return { updated: await repository.markAllRead(actorId, upToId) }
}

export {
   createNotificationJobHandlers,
   countUnreadNotificationsService,
   enqueueAccountEvent,
   enqueueAchievementUnlocked,
   enqueueAssignmentCloseEvents,
   enqueueAttemptExpired,
   enqueueResultUpdated,
   retentionDays,
   runNotificationRetentionService,
   scheduleNotificationRetentionService,
   enqueueCourseEnrolled,
   enqueueExtraAttempts,
   enqueueGroupAnnouncement,
   enqueueGroupMemberJoined,
   enqueueModuleOpened,
   enqueueTestAssigned,
   fanoutJobType,
   listNotificationsService,
   markAllNotificationsReadService,
   markNotificationReadService,
   notificationJobHandlers,
   runNotificationFanoutService,
}
