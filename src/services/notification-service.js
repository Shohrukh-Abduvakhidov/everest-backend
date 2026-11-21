import * as jobRepository from '../repositories/job-repository.js'
import * as notificationRepository from '../repositories/notification-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { renderNotification } from '../utils/notification-texts.js'

// M14 (decisions.md 2026-11-21). Domain services call enqueue* inside their own transaction, so
// a rolled-back change leaves no job (outbox). worker:jobs runs notification.fanout later: it
// re-reads the current state, resolves recipients and writes one in-app notification per user.
// Three UNIQUE keys keep an event from arriving twice: background_jobs.dedupe_key,
// notifications (user_id, dedupe_key) and, from PR 2, the delivery per channel and destination.

const fanoutJobType = 'notification.fanout'
const insertBatchSize = 500

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || notificationRepository,
      jobs: overrides.jobs || jobRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function id(value) {
   return normalizeInternalId(String(value))
}

function coursePath(courseId) {
   return courseId ? `/courses/${courseId}` : '/'
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

function enqueueModuleOpened(client, { grantId, auditId, beginsAt }, overrides) {
   return enqueueFanout(client, {
      event: 'module.opened',
      payload: { grantId: id(grantId), auditId: id(auditId) },
      dedupeKey: `module.opened:${id(grantId)}:${id(auditId)}`,
      availableAt: beginsAt,
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
      targetPath: coursePath(assignment.course_id),
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
         targetPath: coursePath(grant.course_id),
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
   const { repository, transaction } = dependencies(overrides)
   const resolver = resolvers[payload?.event]
   if (!resolver) throw permanentError('NOTIFICATION_EVENT_UNKNOWN')
   return transaction(async (client) => {
      const entries = await resolver(repository, payload, client)
      let created = 0
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
            created += await repository.insertNotifications(rows, client)
         }
      }
      return { created }
   })
}

const notificationJobHandlers = Object.freeze({
   [fanoutJobType]: (payload) => runNotificationFanoutService(payload),
})

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
   countUnreadNotificationsService,
   enqueueAccountEvent,
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
