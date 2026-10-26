import * as groupRepository from '../repositories/group-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'

function dependencies(overrides = {}) {
   return { repository: overrides.repository || groupRepository }
}

function parseGroupId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_GROUP_ID', 'Group identifier is invalid')
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

async function listGroupsService(userId, query, overrides) {
   const { repository } = dependencies(overrides)
   const pagination = parsePagination(query)
   const rows = await repository.listVisibleGroups(
      normalizeInternalId(userId),
      pagination,
   )
   return paginated(rows.map(safeGroup), pagination, 'groups')
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
   const members = rows
      .filter((row) => row.id)
      .map((row) => ({
         id: row.user_id,
         firstName: row.first_name,
         lastName: row.last_name,
         avatarAssetId: row.avatar_asset_id,
         role: row.is_representative ? 'representative' : 'member',
         status: row.status,
         joinedAt: row.joined_at,
      }))
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
   const teachers = rows
      .filter((row) => row.id)
      .map((row) => ({
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
      }))
   return paginated(teachers, pagination, 'teachers')
}

export {
   getGroupService,
   listGroupMembersService,
   listGroupsService,
   listGroupTeachersService,
   parseGroupId,
   parsePagination,
}
