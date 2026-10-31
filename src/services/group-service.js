import { randomBytes } from 'node:crypto'

import * as groupRepository from '../repositories/group-repository.js'
import * as authRepository from '../repositories/auth-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || groupRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      codeSuffix: overrides.codeSuffix || randomCodeSuffix,
   }
}

const groupCodeMaxLength = 80
const groupCodeAttempts = 5
const groupListQueryFields = ['limit', 'offset', 'status', 'q']
const searchMinLength = 2
const searchMaxLength = 100

// Russian and Tajik Cyrillic letters to latin; other characters become hyphens.
const transliteration = {
   а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'gh', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
   и: 'i', ӣ: 'i', й: 'y', к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
   р: 'r', с: 's', т: 't', у: 'u', ӯ: 'u', ф: 'f', х: 'kh', ҳ: 'h', ц: 'ts', ч: 'ch',
   ҷ: 'j', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

function randomCodeSuffix() {
   return randomBytes(4).toString('hex').slice(0, 6)
}

function slugifyGroupName(name) {
   const latin = [...name.toLowerCase()].map((character) => transliteration[character] ?? character).join('')
   const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
   return slug || 'group'
}

function generatedGroupCode(name, suffix) {
   const base = slugifyGroupName(name).slice(0, groupCodeMaxLength - suffix.length - 1).replace(/-+$/, '')
   return `${base}-${suffix}`
}

// LIKE wildcards and the escape character in user input are matched literally.
function escapeLike(value) {
   return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function requireActiveGroup(row) {
   requireGroup(row)
   if (row.status === 'archived') {
      throw new AppError(409, 'GROUP_ARCHIVED', 'Group is archived')
   }
   return row
}

function parseGroupId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_GROUP_ID', 'Group identifier is invalid')
   }
}

function parseUserId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_USER_ID', 'User identifier is invalid')
   }
}

function parseAnnouncementId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_ANNOUNCEMENT_ID', 'Announcement identifier is invalid')
   }
}

function parsePaginationValue(value, fallback, minimum, maximum, field) {
   if (value === undefined) return fallback
   if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
      throw validationError(field)
   }
   const parsed = Number(value)
   if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw validationError(field)
   }
   return parsed
}

function validationError(field) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field, message: `${field} is invalid` },
   ])
}

function validateBody(body, allowedFields) {
   if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('body')
   const unknown = Object.keys(body).find((field) => !allowedFields.includes(field))
   if (unknown) throw validationError(unknown)
}

function text(value, field, maximum, nullable = false) {
   if (nullable && value === null) return null
   if (typeof value !== 'string') throw validationError(field)
   const normalized = value.trim()
   if (!normalized || normalized.length > maximum) throw validationError(field)
   return normalized
}

function boolean(value, field, fallback) {
   if (value === undefined) return fallback
   if (typeof value !== 'boolean') throw validationError(field)
   return value
}

function enumValue(value, field, allowed, fallback) {
   if (value === undefined) return fallback
   if (!allowed.includes(value)) throw validationError(field)
   return value
}

function parsePagination(query = {}) {
   return {
      limit: parsePaginationValue(query.limit, 20, 1, 100, 'limit'),
      offset: parsePaginationValue(query.offset, 0, 0, 1000000, 'offset'),
   }
}

function relationship(row) {
   return {
      member: row.is_member,
      representative: row.is_representative,
      teacher: row.is_teacher,
      administrator: row.administrator,
   }
}

function safeGroup(row) {
   return {
      id: row.id,
      code: row.code,
      name: row.title,
      description: row.description,
      status: row.status,
      memberCount: row.member_count,
      teacherCount: row.teacher_count,
      relationship: relationship(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
   }
}

function managedGroup(row, counts) {
   return {
      id: row.id,
      code: row.code,
      name: row.title,
      description: row.description,
      status: row.status,
      memberCount: counts.member_count,
      teacherCount: counts.teacher_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
   }
}

function safeMember(row) {
   return {
      id: row.user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      avatarAssetId: row.avatar_asset_id,
      role: row.is_representative ? 'representative' : 'member',
      status: row.status,
      joinedAt: row.joined_at,
   }
}

function safeTeacher(row) {
   return {
      id: row.user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      avatarAssetId: row.avatar_asset_id,
      role: 'teacher',
      assignedAt: row.assigned_at,
      permissions: {
         publishAnnouncements: row.can_publish_announcements,
         assignTests: row.can_assign_tests,
         viewResults: row.can_view_results,
      },
   }
}

function announcementContent(content) {
   const block = content?.blocks?.[0]
   return typeof block?.text === 'string' ? block.text : ''
}

function safeAnnouncement(row) {
   return {
      id: row.id,
      groupId: row.group_id,
      authorId: row.author_id,
      title: row.title,
      content: announcementContent(row.content),
      isPinned: row.is_pinned,
      status: row.status,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
   }
}

function announcementJson(content) {
   return { blocks: [{ type: 'paragraph', text: content }] }
}

function requireGroup(row) {
   if (!row) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group was not found')
   return row
}

function requireAnnouncement(row) {
   if (!row) throw new AppError(404, 'ANNOUNCEMENT_NOT_FOUND', 'Announcement was not found')
   return row
}

function requireAnnouncementScope(scope) {
   requireGroup(scope)
   if (!scope.administrator && !scope.assigned_teacher) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Group was not found')
   }
}

async function audit(auth, client, actorUserId, code, entityType, entityId, metadata) {
   await auth.appendAuditEvent({
      actorUserId,
      subjectUserId: null,
      code,
      entityType,
      entityId,
      metadata,
   }, client)
}

function requireVisibleGroup(row) {
   if (!row) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group was not found')
   return row
}

function paginated(items, pagination, key) {
   return {
      [key]: items.slice(0, pagination.limit),
      pagination: {
         ...pagination,
         hasMore: items.length > pagination.limit,
      },
   }
}

function parseGroupListQuery(query = {}) {
   const unknown = Object.keys(query).find((field) => !groupListQueryFields.includes(field))
   if (unknown) throw validationError(unknown)
   for (const field of ['status', 'q']) {
      if (query[field] !== undefined && typeof query[field] !== 'string') throw validationError(field)
   }
   const status = enumValue(query.status, 'status', ['active', 'archived'], null)
   let pattern = null
   if (query.q !== undefined) {
      const search = query.q.trim()
      if (search.length < searchMinLength || search.length > searchMaxLength) throw validationError('q')
      pattern = `%${escapeLike(search)}%`
   }
   return { ...parsePagination(query), status, pattern }
}

async function listGroupsService(userId, query, overrides) {
   const { repository } = dependencies(overrides)
   const filters = parseGroupListQuery(query || {})
   const actorId = normalizeInternalId(userId)
   const rows = await repository.listVisibleGroups(actorId, filters)
   const total = await repository.countVisibleGroups(actorId, filters)
   const pagination = { limit: filters.limit, offset: filters.offset }
   const result = paginated(rows.map(safeGroup), pagination, 'groups')
   result.pagination.total = total
   return result
}

async function getGroupService(userId, groupId, overrides) {
   const { repository } = dependencies(overrides)
   const row = await repository.findVisibleGroup(
      normalizeInternalId(userId),
      parseGroupId(groupId),
   )
   return safeGroup(requireVisibleGroup(row))
}

async function listGroupMembersService(userId, groupId, query, overrides) {
   const { repository } = dependencies(overrides)
   const pagination = parsePagination(query)
   const rows = await repository.listVisibleMembers(
      normalizeInternalId(userId),
      parseGroupId(groupId),
      pagination,
   )
   if (!rows.length) requireVisibleGroup(null)
   const members = rows.filter((row) => row.id).map(safeMember)
   return paginated(members, pagination, 'members')
}

async function listGroupTeachersService(userId, groupId, query, overrides) {
   const { repository } = dependencies(overrides)
   const pagination = parsePagination(query)
   const rows = await repository.listVisibleTeachers(
      normalizeInternalId(userId),
      parseGroupId(groupId),
      pagination,
   )
   if (!rows.length) requireVisibleGroup(null)
   const teachers = rows.filter((row) => row.id).map(safeTeacher)
   return paginated(teachers, pagination, 'teachers')
}

function groupCodeConflict() {
   return new AppError(409, 'GROUP_CODE_CONFLICT', 'Group code already exists')
}

// An explicit code keeps the 409 contract; a generated code retries with a new suffix
// inside the same transaction and never reports a conflict to the caller.
async function insertGroup(repository, codeSuffix, group, client) {
   if (group.code !== null) {
      const created = await repository.createGroup(group, client)
      if (!created) throw groupCodeConflict()
      return created
   }
   for (let attempt = 0; attempt < groupCodeAttempts; attempt += 1) {
      const code = generatedGroupCode(group.title, codeSuffix())
      const created = await repository.createGroup({ ...group, code }, client)
      if (created) return created
   }
   throw new Error('Could not generate a unique group code')
}

async function createGroupService(userId, body, overrides) {
   const { repository, auth, transaction, codeSuffix } = dependencies(overrides)
   validateBody(body, ['code', 'name', 'description', 'status'])
   const group = {
      code: body.code === undefined ? null : text(body.code, 'code', groupCodeMaxLength).toLowerCase(),
      title: text(body.name, 'name', 200),
      description: body.description === undefined ? null : text(body.description, 'description', 2000, true),
      status: enumValue(body.status, 'status', ['active', 'archived'], 'active'),
      actorId: parseUserId(userId),
   }

   return transaction(async (client) => {
      const created = await insertGroup(repository, codeSuffix, group, client)
      await audit(auth, client, group.actorId, 'group.created', 'group', created.id, {
         code: created.code,
         generatedCode: group.code === null,
      })
      return managedGroup(created, { member_count: 0, teacher_count: 0 })
   })
}

async function updateGroupService(userId, groupIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   validateBody(body, ['code', 'name', 'description', 'status'])
   if (!Object.keys(body).length) throw validationError('body')
   const groupId = parseGroupId(groupIdValue)
   const actorId = parseUserId(userId)
   const changes = {
      code: body.code === undefined ? null : text(body.code, 'code', groupCodeMaxLength).toLowerCase(),
      title: body.name === undefined ? null : text(body.name, 'name', 200),
      hasDescription: body.description !== undefined,
      description: body.description === undefined ? null : text(body.description, 'description', 2000, true),
      status: enumValue(body.status, 'status', ['active', 'archived'], null),
   }
   try {
      return await transaction(async (client) => {
         requireGroup(await repository.findGroupForUpdate(groupId, client))
         const updated = await repository.updateGroup(groupId, changes, client)
         await audit(auth, client, actorId, 'group.updated', 'group', groupId, {
            fields: Object.keys(body),
         })
         return managedGroup(updated, await repository.countGroupPeople(groupId, client))
      })
   } catch (error) {
      if (error.code === '23505') throw groupCodeConflict()
      throw error
   }
}

async function addGroupMemberService(userId, groupIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   validateBody(body, ['userId', 'isRepresentative'])
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const targetUserId = parseUserId(body.userId)
   const isRepresentative = boolean(body.isRepresentative, 'isRepresentative', false)
   return transaction(async (client) => {
      requireActiveGroup(await repository.findGroupForUpdate(groupId, client))
      const target = await repository.findEligibleUserForUpdate(targetUserId, 'student', client)
      if (!target || target.status !== 'active' || !target.eligible) {
         throw new AppError(409, 'GROUP_MEMBER_INELIGIBLE', 'User is not eligible for group membership')
      }
      const current = await repository.findMembershipForUpdate(groupId, targetUserId, client)
      if (current?.status === 'active') {
         throw new AppError(409, 'GROUP_MEMBER_ALREADY_ACTIVE', 'User is already an active group member')
      }
      const membership = await repository.saveMembership({
         groupId,
         userId: targetUserId,
         actorId,
         isRepresentative,
      }, client)
      await audit(auth, client, actorId, 'group.member.added', 'group', groupId, {
         userId: targetUserId,
         reactivated: Boolean(current),
      })
      return {
         userId: membership.user_id,
         status: membership.status,
         isRepresentative: membership.is_representative,
         joinedAt: membership.joined_at,
      }
   })
}

async function removeGroupMemberService(userId, groupIdValue, targetValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const targetUserId = parseUserId(targetValue)
   return transaction(async (client) => {
      requireActiveGroup(await repository.findGroupForUpdate(groupId, client))
      const membership = await repository.removeMembership(groupId, targetUserId, client)
      if (!membership) throw new AppError(404, 'GROUP_MEMBER_NOT_FOUND', 'Group member was not found')
      await audit(auth, client, actorId, 'group.member.removed', 'group', groupId, {
         userId: targetUserId,
      })
      return { userId: membership.user_id, status: membership.status, leftAt: membership.left_at }
   })
}

async function addGroupTeacherService(userId, groupIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   validateBody(body, ['userId', 'canPublishAnnouncements', 'canAssignTests', 'canViewResults'])
   const assignment = {
      actorId: parseUserId(userId),
      groupId: parseGroupId(groupIdValue),
      userId: parseUserId(body.userId),
      canPublishAnnouncements: boolean(body.canPublishAnnouncements, 'canPublishAnnouncements', false),
      canAssignTests: boolean(body.canAssignTests, 'canAssignTests', false),
      canViewResults: boolean(body.canViewResults, 'canViewResults', false),
   }
   return transaction(async (client) => {
      requireActiveGroup(await repository.findGroupForUpdate(assignment.groupId, client))
      const target = await repository.findEligibleUserForUpdate(assignment.userId, 'teacher', client)
      if (!target || target.status !== 'active' || !target.eligible) {
         throw new AppError(409, 'GROUP_TEACHER_INELIGIBLE', 'User is not eligible for group teaching')
      }
      if (await repository.findTeacherForUpdate(assignment.groupId, assignment.userId, client)) {
         throw new AppError(409, 'GROUP_TEACHER_ALREADY_ASSIGNED', 'Teacher is already assigned to the group')
      }
      const created = await repository.createTeacher(assignment, client)
      await audit(auth, client, assignment.actorId, 'group.teacher.assigned', 'group', assignment.groupId, {
         userId: assignment.userId,
      })
      return {
         userId: created.user_id,
         assignedAt: created.assigned_at,
         permissions: {
            publishAnnouncements: created.can_publish_announcements,
            assignTests: created.can_assign_tests,
            viewResults: created.can_view_results,
         },
      }
   })
}

async function removeGroupTeacherService(userId, groupIdValue, targetValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const targetUserId = parseUserId(targetValue)
   return transaction(async (client) => {
      requireActiveGroup(await repository.findGroupForUpdate(groupId, client))
      if (!await repository.findTeacherForUpdate(groupId, targetUserId, client)) {
         throw new AppError(404, 'GROUP_TEACHER_NOT_FOUND', 'Group teacher was not found')
      }
      await repository.removeTeacher(groupId, targetUserId, client)
      await audit(auth, client, actorId, 'group.teacher.removed', 'group', groupId, {
         userId: targetUserId,
      })
      return { userId: targetUserId, status: 'removed' }
   })
}

async function updateGroupMemberService(userId, groupIdValue, targetValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   validateBody(body, ['isRepresentative'])
   if (body.isRepresentative === undefined) throw validationError('isRepresentative')
   const isRepresentative = boolean(body.isRepresentative, 'isRepresentative')
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const targetUserId = parseUserId(targetValue)
   return transaction(async (client) => {
      requireActiveGroup(await repository.findGroupForUpdate(groupId, client))
      if (!await repository.updateMembershipRepresentative(groupId, targetUserId, isRepresentative, client)) {
         throw new AppError(404, 'GROUP_MEMBER_NOT_FOUND', 'Group member was not found')
      }
      await audit(auth, client, actorId, 'group.member.updated', 'group', groupId, {
         userId: targetUserId,
         isRepresentative,
      })
      return safeMember(await repository.findMemberItem(groupId, targetUserId, client))
   })
}

async function updateGroupTeacherService(userId, groupIdValue, targetValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   validateBody(body, ['canPublishAnnouncements', 'canAssignTests', 'canViewResults'])
   if (!Object.keys(body).length) throw validationError('body')
   const changes = {
      canPublishAnnouncements: boolean(body.canPublishAnnouncements, 'canPublishAnnouncements', null),
      canAssignTests: boolean(body.canAssignTests, 'canAssignTests', null),
      canViewResults: boolean(body.canViewResults, 'canViewResults', null),
   }
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const targetUserId = parseUserId(targetValue)
   return transaction(async (client) => {
      requireActiveGroup(await repository.findGroupForUpdate(groupId, client))
      if (!await repository.updateTeacherPermissions(groupId, targetUserId, changes, client)) {
         throw new AppError(404, 'GROUP_TEACHER_NOT_FOUND', 'Group teacher was not found')
      }
      await audit(auth, client, actorId, 'group.teacher.updated', 'group', groupId, {
         userId: targetUserId,
         fields: Object.keys(body),
      })
      return safeTeacher(await repository.findTeacherItem(groupId, targetUserId, client))
   })
}

async function listGroupAnnouncementsService(userId, groupId, query, overrides) {
   const { repository } = dependencies(overrides)
   const pagination = parsePagination(query)
   const status = enumValue(query?.status, 'status', ['draft', 'published', 'archived'], null)
   const rows = await repository.listVisibleAnnouncements(
      parseUserId(userId),
      parseGroupId(groupId),
      { ...pagination, status },
   )
   if (!rows.length) requireVisibleGroup(null)
   return paginated(rows.filter((row) => row.id).map(safeAnnouncement), pagination, 'announcements')
}

function parseAnnouncementBody(body, partial = false) {
   validateBody(body, ['title', 'content', 'isPinned', 'status'])
   if (partial && !Object.keys(body).length) throw validationError('body')
   return {
      title: body.title === undefined && partial ? null : text(body.title, 'title', 200),
      hasContent: body.content !== undefined,
      content: body.content === undefined && partial ? null : announcementJson(text(body.content, 'content', 10000)),
      isPinned: boolean(body.isPinned, 'isPinned', partial ? null : false),
      status: enumValue(body.status, 'status', ['draft', 'published'], partial ? null : 'draft'),
   }
}

async function createGroupAnnouncementService(userId, groupIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const values = parseAnnouncementBody(body)
   return transaction(async (client) => {
      const scope = await repository.findAnnouncementManagerScope(actorId, groupId, client)
      requireAnnouncementScope(scope)
      requireActiveGroup(scope)
      const created = await repository.createAnnouncement({
         groupId,
         authorId: actorId,
         ...values,
      }, client)
      await audit(auth, client, actorId, 'group.announcement.created', 'group_announcement', created.id, {
         groupId,
      })
      return safeAnnouncement(created)
   })
}

async function updateGroupAnnouncementService(userId, groupIdValue, announcementValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const announcementId = parseAnnouncementId(announcementValue)
   const changes = parseAnnouncementBody(body, true)
   return transaction(async (client) => {
      requireAnnouncementScope(await repository.findAnnouncementManagerScope(actorId, groupId, client))
      requireAnnouncement(await repository.findAnnouncementForUpdate(groupId, announcementId, client))
      const updated = await repository.updateAnnouncement(announcementId, changes, client)
      await audit(auth, client, actorId, 'group.announcement.updated', 'group_announcement', announcementId, {
         groupId,
         fields: Object.keys(body),
      })
      return safeAnnouncement(updated)
   })
}

async function archiveGroupAnnouncementService(userId, groupIdValue, announcementValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const announcementId = parseAnnouncementId(announcementValue)
   return transaction(async (client) => {
      requireAnnouncementScope(await repository.findAnnouncementManagerScope(actorId, groupId, client))
      requireAnnouncement(await repository.findAnnouncementForUpdate(groupId, announcementId, client))
      const archived = await repository.archiveAnnouncement(announcementId, client)
      await audit(auth, client, actorId, 'group.announcement.archived', 'group_announcement', announcementId, {
         groupId,
      })
      return safeAnnouncement(archived)
   })
}

export {
   addGroupMemberService,
   addGroupTeacherService,
   archiveGroupAnnouncementService,
   createGroupAnnouncementService,
   createGroupService,
   getGroupService,
   listGroupMembersService,
   listGroupsService,
   listGroupTeachersService,
   listGroupAnnouncementsService,
   parseAnnouncementId,
   parseGroupId,
   parsePagination,
   removeGroupMemberService,
   removeGroupTeacherService,
   updateGroupAnnouncementService,
   updateGroupMemberService,
   updateGroupService,
   updateGroupTeacherService,
}
