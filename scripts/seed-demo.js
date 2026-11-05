import { randomBytes } from 'node:crypto'

import pool from '../src/configs/db.js'
import env from '../src/configs/env.js'
import { findOwnerAssignment, findUserRoles } from '../src/repositories/account-admin-repository.js'
import { findPasswordAccountByPhone } from '../src/repositories/user-repository.js'
import {
   approveUserService,
   blockUserService,
   bootstrapOwnerService,
   rejectUserService,
   replaceUserRolesService,
} from '../src/services/account-admin-service.js'
import {
   grantCourseEnrollmentService,
   grantModuleAccessService,
} from '../src/services/course-access-service.js'
import {
   createCourseModuleService,
   previewCourseModulesService,
   publishCourseModuleService,
} from '../src/services/course-module-service.js'
import {
   addCourseTeacherService,
   createCourseService,
   listCoursesService,
   publishCourseService,
} from '../src/services/course-service.js'
import {
   addGroupMemberService,
   addGroupTeacherService,
   createGroupAnnouncementService,
   createGroupService,
   listGroupAnnouncementsService,
   listGroupsService,
} from '../src/services/group-service.js'
import {
   createLessonService,
   listModuleLessonsService,
   publishLessonService,
} from '../src/services/lesson-service.js'
import { authRegisterService } from '../src/services/password-auth-service.js'
import { completeOnboardingService } from '../src/services/profile-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   listBankQuestionsService,
   listQuestionBanksService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../src/services/question-bank-service.js'
import {
   addTestQuestionsService,
   createAssignmentService,
   createTestService,
   getTestService,
   listAssignmentsService,
   listTestsService,
   publishTestService,
} from '../src/services/test-service.js'
import { ensureTaxonomy, seedRichDemoContent } from './seed-demo-content.js'

// Development seed: demo accounts and content created through the same services the API
// uses, so validation rules and audit events apply. Re-running skips whatever exists.

const accountDefinitions = [
   { key: 'owner', label: 'owner', phone: '+992900000001', firstName: 'Farhod', roles: ['owner', 'student'] },
   { key: 'admin', label: 'admin', phone: '+992900000002', firstName: 'Madina', roles: ['admin', 'student'] },
   { key: 'teacher', label: 'teacher', phone: '+992900000003', firstName: 'Jamshed', roles: ['student', 'teacher'] },
   { key: 'student1', label: 'student', phone: '+992900000004', firstName: 'Aziza', roles: ['student'] },
   { key: 'student2', label: 'student', phone: '+992900000005', firstName: 'Bahrom', roles: ['student'] },
   { key: 'student3', label: 'student', phone: '+992900000006', firstName: 'Dilnoza', roles: ['student'] },
   { key: 'student4', label: 'student', phone: '+992900000007', firstName: 'Eraj', roles: ['student'] },
   { key: 'student5', label: 'student', phone: '+992900000008', firstName: 'Firuza', roles: ['student'] },
   // Extra students for the users page, group rosters and test assignments.
   ...[
      ['Рустам', 'Назаров'],
      ['Нигина', 'Рахимова'],
      ['Фаррух', 'Исмоилов'],
      ['Сарвар', 'Каримов'],
      ['Зарина', 'Саидова'],
      ['Умед', 'Холов'],
      ['Мехрона', 'Бобоева'],
      ['Достон', 'Юсупов'],
      ['Парвина', 'Шарипова'],
      ['Бахтиёр', 'Одинаев'],
      ['Гулнора', 'Мирзоева'],
      ['Сухроб', 'Давлатов'],
   ].map(([firstName, lastName], index) => ({
      key: `student${index + 6}`,
      label: 'student',
      phone: `+9929000000${String(index + 9).padStart(2, '0')}`,
      firstName,
      lastName,
      roles: ['student'],
   })),
   // Two more teachers so course and group permissions can differ.
   { key: 'teacher2', label: 'teacher', phone: '+992900000021', firstName: 'Шоира', lastName: 'Кодирова', roles: ['student', 'teacher'] },
   { key: 'teacher3', label: 'teacher', phone: '+992900000022', firstName: 'Икбол', lastName: 'Рахмонов', roles: ['student', 'teacher'] },
   // Accounts that are not active, so the users page shows every status.
   { key: 'pending1', label: 'pending', phone: '+992900000023', firstName: 'Тимур', lastName: 'Азизов', roles: ['student'], state: 'pending' },
   { key: 'pending2', label: 'pending', phone: '+992900000024', firstName: 'Лола', lastName: 'Сафарова', roles: ['student'], state: 'pending' },
   { key: 'blocked', label: 'blocked', phone: '+992900000025', firstName: 'Анвар', lastName: 'Ташев', roles: ['student'], state: 'blocked' },
   { key: 'rejected', label: 'rejected', phone: '+992900000026', firstName: 'Санавбар', lastName: 'Расулова', roles: ['student'], state: 'rejected' },
]
const demoLastName = 'Demo'

class SeedRefusal extends Error {}

function parseArguments(argv) {
   const options = { force: false, password: undefined, verbose: false }
   for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index]
      if (argument === '--force') {
         options.force = true
      } else if (argument === '--verbose') {
         options.verbose = true
      } else if (argument === '--password') {
         options.password = argv[index + 1]
         index += 1
         if (!options.password) throw new SeedRefusal('--password needs a value')
      } else {
         throw new SeedRefusal(`Unknown argument: ${argument}`)
      }
   }
   return options
}

function assertSafeTarget({ nodeEnv, database, force }) {
   if (nodeEnv === 'production') {
      throw new SeedRefusal('Refusing to seed: NODE_ENV is production')
   }
   if (!force && !/dev|test|demo/i.test(database)) {
      throw new SeedRefusal(
         `Refusing to seed database "${database}": its name does not contain dev, test or demo. `
         + 'Use a disposable database or pass --force.',
      )
   }
}

// Runs a create step and treats the listed conflict codes as "already there".
async function createOnce(create, conflictCodes) {
   try {
      return { created: true, value: await create() }
   } catch (error) {
      if (conflictCodes.includes(error.code)) return { created: false, value: null }
      throw error
   }
}

async function collectPages(fetchPage, readItems) {
   const items = []
   for (let offset = 0; ; offset += 100) {
      const page = await fetchPage({ limit: '100', offset: String(offset) })
      items.push(...readItems(page))
      if (!page.pagination?.hasMore) return items
   }
}

const report = { accounts: [], content: [] }

function note(kind, name, created) {
   report.content.push({ kind, name, result: created ? 'created' : 'exists' })
}

async function ensureProfileReady(userId) {
   await completeOnboardingService(userId)
}

async function ensureOwner(definition, password) {
   const existingOwner = await findOwnerAssignment(pool)
   const account = await findPasswordAccountByPhone(definition.phone)
   if (existingOwner) {
      const isDemoOwner = account?.user_id === existingOwner.user_id
      if (isDemoOwner) await ensureProfileReady(account.user_id)
      report.accounts.push({
         role: definition.label,
         phone: definition.phone,
         result: isDemoOwner ? 'exists' : 'skipped (an owner already exists)',
      })
      return existingOwner.user_id
   }
   if (!account) {
      await authRegisterService({
         phone: definition.phone,
         password,
         firstName: definition.firstName,
         lastName: definition.lastName || demoLastName,
      })
   }
   const { userId } = await bootstrapOwnerService(definition.phone)
   await ensureProfileReady(userId)
   report.accounts.push({ role: definition.label, phone: definition.phone, result: 'created' })
   return userId
}

async function ensureAccount(definition, password, actorId) {
   let account = await findPasswordAccountByPhone(definition.phone)
   const created = !account
   if (!account) {
      await authRegisterService({
         phone: definition.phone,
         password,
         firstName: definition.firstName,
         lastName: definition.lastName || demoLastName,
      })
      account = await findPasswordAccountByPhone(definition.phone)
   }
   const userId = account.user_id
   const desiredState = definition.state
   if (account.status === 'pending' && desiredState === 'rejected') {
      await rejectUserService(actorId, userId)
   } else if (account.status === 'pending' && desiredState !== 'pending') {
      await approveUserService(actorId, userId)
      // Only a newly approved account is blocked, so a later manual unblock is kept.
      if (desiredState === 'blocked') await blockUserService(actorId, userId)
   }
   // Roles are only raised from the bare student role, so later manual changes are kept.
   const currentRoles = await findUserRoles(userId)
   if (definition.roles.length > 1 && currentRoles.join() === 'student') {
      await replaceUserRolesService(actorId, userId, { roles: definition.roles })
   }
   if (!desiredState && account.status !== 'blocked' && account.status !== 'rejected') {
      await ensureProfileReady(userId)
   }
   report.accounts.push({
      role: definition.label,
      phone: definition.phone,
      result: created ? 'created' : `exists (${account.status})`,
      ...(created && desiredState ? { status: desiredState } : {}),
   })
   return userId
}

async function ensureCourse(actorId, { title, description, subjectId }) {
   const courses = await collectPages(
      (query) => listCoursesService(actorId, query),
      (page) => page.courses,
   )
   const found = courses.find((course) => course.title === title)
   if (found) {
      note('course', title, false)
      return found
   }
   const course = await createCourseService(actorId, { title, description, subjectId, languageCode: 'en' })
   note('course', title, true)
   return course
}

function lessonBlocks(topic, points) {
   return {
      blocks: [
         { type: 'heading', text: topic, level: 2 },
         { type: 'paragraph', text: `This demo lesson introduces ${topic.toLowerCase()}.` },
         { type: 'list', items: points, ordered: false },
      ],
   }
}

async function ensureModuleWithLessons(actorId, courseId, definition) {
   const preview = await previewCourseModulesService(actorId, courseId)
   let module = preview.modules.find((item) => item.title === definition.title)
   const moduleCreated = !module
   if (!module) module = await createCourseModuleService(actorId, courseId, { title: definition.title })
   note('module', definition.title, moduleCreated)

   for (const lesson of definition.lessons) {
      const { lessons } = await listModuleLessonsService(actorId, courseId, module.id)
      let existing = lessons.find((item) => item.title === lesson.title)
      const lessonCreated = !existing
      if (!existing) {
         existing = await createLessonService(actorId, courseId, module.id, {
            title: lesson.title,
            lessonType: 'text',
            content: lessonBlocks(lesson.title, lesson.points),
         })
      }
      if (existing.status === 'draft') await publishLessonService(actorId, courseId, existing.id)
      note('lesson', lesson.title, lessonCreated)
   }
   if (module.status === 'draft') await publishCourseModuleService(actorId, courseId, module.id)
   return module.id
}

const biologyModules = [
   {
      title: 'Module 1: The Cell',
      lessons: [
         { title: 'Cell structure', points: ['Membrane', 'Cytoplasm', 'Nucleus'] },
         { title: 'Organelles', points: ['Mitochondria', 'Ribosomes', 'Golgi apparatus'] },
         { title: 'Cell division', points: ['Mitosis', 'Meiosis'] },
      ],
   },
   {
      title: 'Module 2: Genetics',
      lessons: [
         { title: 'DNA and genes', points: ['Double helix', 'Nucleotides', 'Genes'] },
         { title: 'Inheritance', points: ['Dominant alleles', 'Recessive alleles'] },
         { title: 'Mutations', points: ['Point mutations', 'Chromosomal changes'] },
      ],
   },
]

async function ensureGroup(actorId, studentIds, teacherId) {
   const code = 'demo-group-a'
   const name = 'Demo Group A'
   const created = await createOnce(
      () => createGroupService(actorId, { code, name, description: 'Demo group for development' }),
      ['GROUP_CODE_CONFLICT'],
   )
   let group = created.value
   if (!group) {
      const listed = await listGroupsService(actorId, { q: name, limit: '100' })
      group = listed.groups.find((item) => item.code === code)
   }
   note('group', name, created.created)

   for (const studentId of studentIds) {
      const member = await createOnce(
         () => addGroupMemberService(actorId, group.id, { userId: studentId }),
         ['GROUP_MEMBER_ALREADY_ACTIVE'],
      )
      note('group member', `${name} / user ${studentId}`, member.created)
   }
   const teacher = await createOnce(
      () => addGroupTeacherService(actorId, group.id, {
         userId: teacherId,
         canPublishAnnouncements: true,
         canViewResults: true,
      }),
      ['GROUP_TEACHER_ALREADY_ASSIGNED'],
   )
   note('group teacher', `${name} / user ${teacherId}`, teacher.created)

   const { announcements } = await listGroupAnnouncementsService(actorId, group.id, { limit: '100' })
   const demoAnnouncements = [
      { title: 'Welcome to Demo Group A', content: 'The first demo announcement. Classes start next week.', isPinned: true },
      { title: 'Schedule update', content: 'The second demo announcement. The schedule is posted in the course.', isPinned: false },
   ]
   for (const announcement of demoAnnouncements) {
      const exists = announcements.some((item) => item.title === announcement.title)
      if (!exists) {
         await createGroupAnnouncementService(actorId, group.id, { ...announcement, status: 'published' })
      }
      note('announcement', announcement.title, !exists)
   }
   return group.id
}

function text(value) {
   return { blocks: [{ type: 'text', text: value }] }
}

function option(key, value) {
   return { key, content: text(value) }
}

const demoQuestions = [
   {
      externalId: 'demo-single-choice',
      body: {
         questionType: 'single_choice',
         content: text('Which organelle produces most of the cell energy?'),
         options: [option('A', 'Nucleus'), option('B', 'Mitochondrion'), option('C', 'Ribosome')],
      },
      answerData: { optionKey: 'B' },
   },
   {
      externalId: 'demo-multiple-choice',
      body: {
         questionType: 'multiple_choice',
         content: text('Which of these are parts of DNA nucleotides?'),
         options: [option('A', 'Phosphate group'), option('B', 'Sugar'), option('C', 'Amino acid'), option('D', 'Nitrogenous base')],
      },
      answerData: { optionKeys: ['A', 'B', 'D'] },
   },
   {
      externalId: 'demo-matching',
      body: {
         questionType: 'matching',
         content: text('Match each structure with its function.'),
         interactionSettings: { requireAllLeft: true, allowRightReuse: false },
         matching: {
            left: [option('L1', 'Ribosome'), option('L2', 'Mitochondrion')],
            right: [option('R1', 'Protein synthesis'), option('R2', 'Energy release')],
         },
      },
      answerData: { pairs: [{ left: 'L1', right: 'R1' }, { left: 'L2', right: 'R2' }] },
   },
   {
      externalId: 'demo-numeric',
      body: {
         questionType: 'numeric',
         content: text('How many chromosomes does a typical human somatic cell contain?'),
      },
      answerData: { value: 46 },
   },
   {
      externalId: 'demo-short-text',
      body: {
         questionType: 'short_text',
         content: text('Name the process by which a cell divides into two identical cells.'),
      },
      answerData: { acceptedAnswers: ['mitosis', 'Mitosis'] },
   },
]

async function ensureQuestionBank(actorId, subjectId) {
   const code = 'demo-biology-bank'
   const created = await createOnce(
      () => createQuestionBankService(actorId, {
         code,
         title: 'Demo biology question bank',
         subjectId,
         visibility: 'staff',
      }),
      ['QUESTION_BANK_CODE_CONFLICT'],
   )
   let bank = created.value
   if (!bank) {
      const { banks } = await listQuestionBanksService(actorId, { limit: '100' })
      bank = banks.find((item) => item.code === code)
   }
   note('question bank', code, created.created)

   const { questions } = await listBankQuestionsService(actorId, bank.id, { limit: '100' })
   const questionIds = []
   for (const definition of demoQuestions) {
      let question = questions.find((item) => item.externalId === definition.externalId)
      const questionCreated = !question
      if (!question) {
         question = await createQuestionService(actorId, bank.id, {
            ...definition.body,
            externalId: definition.externalId,
            languageCode: 'en',
            difficulty: 2,
            difficultySource: 'expert',
         })
      }
      // A rerun after an interrupted run resumes at the first unfinished step.
      if (question.status === 'draft') {
         let keyStatus = question.keyStatus
         if (keyStatus === 'unknown') {
            await replaceAnswerKeyService(actorId, question.id, {
               answerData: definition.answerData,
               source: 'expert_review',
            })
            keyStatus = 'proposed'
         }
         if (keyStatus === 'proposed') {
            await verifyAnswerKeyService(actorId, question.id, { source: 'expert_review' })
         }
         await publishQuestionService(actorId, question.id)
      }
      note('question', definition.externalId, questionCreated)
      questionIds.push(question.id)
   }
   return questionIds
}

async function ensureDemoTest(actorId, courseId, questionIds, groupId) {
   const title = 'Biology Fundamentals quiz (demo)'
   const { tests } = await listTestsService(actorId, { courseId, limit: '100' })
   const existing = tests.find((item) => item.title === title)
   const test = existing || await createTestService(actorId, { courseId, title, passPercent: 60 })
   note('test', title, !existing)
   // A rerun after an interrupted run resumes at the first unfinished step.
   if (test.status === 'draft') {
      const { questions } = await getTestService(actorId, test.id)
      if (!questions.length) {
         await addTestQuestionsService(actorId, test.id, {
            questions: questionIds.map((questionId) => ({ questionId })),
         })
      }
      await publishTestService(actorId, test.id)
   }
   const { assignments } = await listAssignmentsService(actorId, test.id, { status: 'active' })
   const assigned = assignments.some((item) => item.groupId === groupId)
   if (!assigned) await createAssignmentService(actorId, test.id, { groupId })
   note('test assignment', `${title} / group ${groupId}`, !assigned)
}

async function ensureEnrollments(actorId, courseId, moduleIds, studentIds) {
   for (const studentId of studentIds) {
      const enrollment = await createOnce(
         () => grantCourseEnrollmentService(actorId, courseId, { userId: studentId, expiresAt: null }),
         ['ENROLLMENT_ALREADY_EXISTS'],
      )
      note('enrollment', `user ${studentId}`, enrollment.created)
      for (const moduleId of moduleIds) {
         const grant = await createOnce(
            () => grantModuleAccessService(actorId, courseId, studentId, { moduleId, expiresAt: null }),
            ['MODULE_ACCESS_ALREADY_EXISTS'],
         )
         note('module grant', `user ${studentId} / module ${moduleId}`, grant.created)
      }
   }
}

async function seedContent(actorId, userIds) {
   const context = { actorId, userIds, note, createOnce, collectPages }
   const subjects = await ensureTaxonomy(context)
   const biologyId = subjects.get('demo-biology').id
   const chemistryId = subjects.get('demo-chemistry').id

   const course = await ensureCourse(actorId, {
      title: 'Biology Fundamentals (demo)',
      description: 'Published demo course with two modules and six text lessons.',
      subjectId: biologyId,
   })
   const moduleIds = []
   for (const definition of biologyModules) {
      moduleIds.push(await ensureModuleWithLessons(actorId, course.id, definition))
   }
   if (course.status === 'draft') await publishCourseService(actorId, course.id)

   await ensureCourse(actorId, {
      title: 'Chemistry Basics (draft demo)',
      description: 'Draft demo course that students cannot see.',
      subjectId: chemistryId,
   })

   const courseTeacher = await createOnce(
      () => addCourseTeacherService(actorId, course.id, {
         userId: userIds.teacher,
         canEditCourse: true,
         canManageLessons: true,
         canManageQuestions: true,
         canManageTests: true,
         canViewResults: true,
      }),
      ['COURSE_TEACHER_ALREADY_ASSIGNED'],
   )
   note('course teacher', `user ${userIds.teacher}`, courseTeacher.created)

   const studentIds = [userIds.student1, userIds.student2, userIds.student3, userIds.student4, userIds.student5]
   const groupId = await ensureGroup(actorId, studentIds.slice(0, 3), userIds.teacher)
   const questionIds = await ensureQuestionBank(actorId, biologyId)
   await ensureDemoTest(actorId, course.id, questionIds, groupId)
   await ensureEnrollments(actorId, course.id, moduleIds, studentIds.slice(0, 2))

   // Rich Russian/Tajik content: courses, banks, tests, groups and access states.
   await seedRichDemoContent(context, { subjects, groupAId: groupId })
}

function summarize() {
   const totals = new Map()
   for (const row of report.content) {
      const total = totals.get(row.kind) || { kind: row.kind, created: 0, existing: 0 }
      if (row.result === 'created') total.created += 1
      else total.existing += 1
      totals.set(row.kind, total)
   }
   return [...totals.values()]
}

const checklist = [
   ['+992900000001 owner', 'Everything: users page (all statuses), settings, any course, bank, test or group.'],
   ['+992900000002 admin', 'The same admin screens as the owner, without owner-only actions.'],
   ['+992900000003 teacher', 'Teacher view: "Биология 9 класс" (all permissions), "Химия 9 класс" (content only), group A.'],
   ['+992900000021 teacher', 'Teacher with all rights in "Химия 9 класс", assessment rights in the math course, group B (can assign tests).'],
   ['+992900000022 teacher', 'Teacher with assessment rights in physics, results-only in math, group B and the archived group C.'],
   ['+992900000004 student 1', 'Full access to "Биология 9 класс" (two modules); chemistry with one module ending in 3 days.'],
   ['+992900000005 student 2', 'Scheduled biology enrollment (starts in 7 days); active math with three modules.'],
   ['+992900000006 student 3', 'Expired biology enrollment; physics with an active and a revoked module grant.'],
   ['+992900000007 student 4', 'Revoked chemistry enrollment; math enrollment reinstated after revocation.'],
   ['+992900000008 student 5', 'Full physics access; scheduled math enrollment.'],
   ['+992900000009..20 students', 'Group B and the archived group C rosters, user pickers, enrollment search.'],
   ['+992900000023, 024', 'Pending accounts: approve or reject them on the approvals screen.'],
   ['+992900000025 / 026', 'A blocked and a rejected account (cannot log in).'],
]

const screens = [
   'Subjects and taxonomy: 5 subjects with colors, sections and nested topics.',
   'Courses: 5 published, 1 draft; a draft module in biology, an archived module in chemistry.',
   'Lessons: text, mixed and draft video lessons (video storage is not configured).',
   'Question banks: 5 banks (four staff, one private) with published, draft and archived questions of every type, in ru, tg and en.',
   'Tests: 4 published (open now, upcoming and closed windows), 1 draft, 1 archived; group and student assignments.',
   'Groups: A, B and one archived group C, with representatives, teachers and announcements (draft, published, pinned, archived).',
   'Access: enrollments in every state and module grants (active, scheduled, expired, revoked).',
]

function printReport(password, passwordGenerated, verbose) {
   console.log('\nAccounts')
   console.table(report.accounts)
   if (verbose) {
      console.log('Content (every record)')
      console.table(report.content)
   }
   console.log('Summary of content (created in this run / already existed)')
   console.table(summarize())
   const createdAccounts = report.accounts.filter((account) => account.result === 'created').length
   if (createdAccounts) {
      console.log(
         passwordGenerated
            ? `Password for the ${createdAccounts} newly created accounts (shown once, not stored): ${password}`
            : `The ${createdAccounts} newly created accounts use the password you supplied.`,
      )
   }
   console.log('Accounts that already existed keep their original password.')
   console.log('\nWhat to look at: accounts')
   console.table(checklist.map(([account, screen]) => ({ account, screen })))
   console.log('What to look at: screens')
   for (const line of screens) console.log(`- ${line}`)
}

async function main() {
   const options = parseArguments(process.argv.slice(2))
   const { host, port, database } = env.database
   console.log('Seed target', { host, port, database, nodeEnv: env.nodeEnv })
   assertSafeTarget({ nodeEnv: env.nodeEnv, database, force: options.force })

   const suppliedPassword = options.password ?? process.env.SEED_PASSWORD
   const passwordGenerated = !suppliedPassword
   const password = suppliedPassword || `Demo${randomBytes(6).toString('hex')}7`

   const [ownerDefinition, ...others] = accountDefinitions
   const ownerId = await ensureOwner(ownerDefinition, password)
   const userIds = { owner: ownerId }
   for (const definition of others) {
      userIds[definition.key] = await ensureAccount(definition, password, ownerId)
   }
   await seedContent(ownerId, userIds)
   printReport(password, passwordGenerated, options.verbose)
}

try {
   await main()
} catch (error) {
   if (error instanceof SeedRefusal) {
      console.error(error.message)
   } else {
      console.error('Seed failed', { code: error.code || 'SEED_FAILED', message: error.message, details: error.details })
      if (!error.code) console.error(error.stack)
   }
   process.exitCode = 1
} finally {
   await pool.end()
}
