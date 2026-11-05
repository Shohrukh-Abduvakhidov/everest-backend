import {
   extendCourseEnrollmentService,
   grantCourseEnrollmentService,
   grantModuleAccessService,
   listCourseEnrollmentsService,
   listModuleAccessGrantsService,
   revokeCourseEnrollmentService,
   revokeModuleAccessService,
} from '../src/services/course-access-service.js'
import {
   archiveCourseModuleService,
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
   archiveGroupAnnouncementService,
   createGroupAnnouncementService,
   createGroupService,
   listGroupAnnouncementsService,
   listGroupMembersService,
   listGroupsService,
   updateGroupMemberService,
   updateGroupService,
} from '../src/services/group-service.js'
import {
   createLessonService,
   listModuleLessonsService,
   publishLessonService,
} from '../src/services/lesson-service.js'
import {
   archiveQuestionService,
   createQuestionBankService,
   createQuestionService,
   listBankQuestionsService,
   listQuestionBanksService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../src/services/question-bank-service.js'
import {
   createSectionService,
   createSubjectService,
   createTopicService,
   listSectionsService,
   listSubjectsService,
   listTopicsService,
   updateSubjectService,
} from '../src/services/taxonomy-service.js'
import {
   addTestQuestionsService,
   archiveTestService,
   createAssignmentService,
   createTestService,
   getTestService,
   listAssignmentsService,
   listTestsService,
   publishTestService,
   updateAssignmentService,
} from '../src/services/test-service.js'
import { withClosing } from './seed-demo-data/lesson-extras.js'
import biologyCourse from './seed-demo-data/course-biology.js'
import chemistryCourse from './seed-demo-data/course-chemistry.js'
import mathCourse from './seed-demo-data/course-math.js'
import physicsCourse from './seed-demo-data/course-physics.js'
import biologyQuestions from './seed-demo-data/questions-biology.js'
import chemistryQuestions from './seed-demo-data/questions-chemistry.js'
import mathQuestions from './seed-demo-data/questions-math.js'
import physicsQuestions from './seed-demo-data/questions-physics.js'
import russianQuestions from './seed-demo-data/questions-russian.js'
import { subjects as subjectCatalog } from './seed-demo-data/taxonomy.js'

// Rich demo content for manual testing. Everything goes through the same services as the
// API, so validation, ownership rules and audit events apply. Reruns skip what exists, found
// by stable codes, titles and external ids.

const day = 24 * 60 * 60 * 1000
const at = (days) => new Date(Date.now() + days * day).toISOString()

const courseCatalog = [biologyCourse, chemistryCourse, physicsCourse, mathCourse]
const bankCatalog = {
   'demo-biology': biologyQuestions,
   'demo-chemistry': chemistryQuestions,
   'demo-physics': physicsQuestions,
   'demo-math': mathQuestions,
   'demo-russian': russianQuestions,
}

// ---------------------------------------------------------------- taxonomy

async function ensureSubjectAndTaxonomy(context, definition) {
   const { actorId, note } = context
   const translations = {
      ru: { title: definition.titles.ru },
      tg: { title: definition.titles.tg },
      en: { title: definition.titles.en },
   }
   const { subjects } = await listSubjectsService()
   let subject = subjects.find((item) => item.code === definition.code)
   if (!subject) {
      subject = await createSubjectService(actorId, {
         code: definition.code,
         color: definition.color,
         primaryLanguage: 'ru',
         translations,
      })
      note('subject', definition.code, true)
   } else {
      // A subject from the earlier English seed gains the Tajik and Russian titles.
      if (!subject.translations.tg || !subject.translations.ru) {
         subject = await updateSubjectService(actorId, subject.id, {
            translations: { ...translations, ...subject.translations },
         })
      }
      note('subject', definition.code, false)
   }

   const { sections } = await listSectionsService(subject.id)
   const { topics } = await listTopicsService(subject.id)
   const topicIds = new Map(topics.map((topic) => [topic.code, topic.id]))
   const sectionIds = new Map(sections.map((section) => [section.code, section.id]))

   async function ensureTopic(topic, sectionId, parentId) {
      let id = topicIds.get(topic.code)
      note('topic', topic.code, !id)
      if (!id) {
         const created = await createTopicService(actorId, subject.id, {
            code: topic.code,
            primaryLanguage: 'ru',
            sectionId,
            ...(parentId ? { parentId } : {}),
            translations: { ru: { title: topic.ru }, tg: { title: topic.tg } },
         })
         id = created.id
         topicIds.set(topic.code, id)
      }
      for (const kid of topic.kids) await ensureTopic(kid, sectionId, id)
   }

   for (const section of definition.sections) {
      let sectionId = sectionIds.get(section.code)
      note('section', section.code, !sectionId)
      if (!sectionId) {
         const created = await createSectionService(actorId, subject.id, {
            code: section.code,
            primaryLanguage: 'ru',
            translations: { ru: { title: section.ru }, tg: { title: section.tg } },
         })
         sectionId = created.id
      }
      for (const topic of section.topics) await ensureTopic(topic, sectionId, null)
   }
   return { id: subject.id, topicIds }
}

// Creates or reuses all subjects with their sections and topics. Returns code -> { id, topicIds }.
async function ensureTaxonomy(context) {
   const map = new Map()
   for (const definition of subjectCatalog) {
      map.set(definition.code, await ensureSubjectAndTaxonomy(context, definition))
   }
   return map
}

// ---------------------------------------------------------------- courses

async function ensureModuleWithLessons(context, courseId, data) {
   const { actorId, note } = context
   const preview = await previewCourseModulesService(actorId, courseId)
   let module = preview.modules.find((item) => item.title === data.title)
   const moduleCreated = !module
   if (!module) {
      module = await createCourseModuleService(actorId, courseId, {
         title: data.title,
         translations: { tg: { title: data.tgTitle } },
      })
   }
   note('module', data.title, moduleCreated)

   // Lessons of a draft module and video lessons (no real storage) stay drafts.
   const publishLessons = data.status !== 'draft'
   for (const lesson of data.lessons) {
      const { lessons } = await listModuleLessonsService(actorId, courseId, module.id)
      let existing = lessons.find((item) => item.title === lesson.title)
      const lessonCreated = !existing
      if (!existing) {
         existing = await createLessonService(actorId, courseId, module.id, {
            title: lesson.title,
            lessonType: lesson.lessonType,
            content: { blocks: withClosing(lesson.title, lesson.blocks) },
            translations: { tg: { title: lesson.tgTitle } },
         })
      }
      if (publishLessons && lesson.lessonType !== 'video' && existing.status === 'draft') {
         await publishLessonService(actorId, courseId, existing.id)
      }
      note('lesson', lesson.title, lessonCreated)
   }

   let status = module.status
   if (data.status !== 'draft' && status === 'draft') {
      await publishCourseModuleService(actorId, courseId, module.id)
      status = 'published'
      if (data.status === 'archived') {
         await archiveCourseModuleService(actorId, courseId, module.id)
         status = 'archived'
      }
   }
   return { id: module.id, status }
}

async function ensureCourse(context, data, subjectId) {
   const { actorId, note, collectPages } = context
   const courses = await collectPages(
      (query) => listCoursesService(actorId, query),
      (page) => page.courses,
   )
   let course = courses.find((item) => item.title === data.title)
   const created = !course
   if (!course) {
      course = await createCourseService(actorId, {
         title: data.title,
         description: data.description,
         subjectId,
         languageCode: 'ru',
         translations: { tg: { title: data.tgTitle, description: data.tgDescription } },
      })
   }
   note('course', data.title, created)

   const modules = []
   for (const moduleData of data.modules) {
      modules.push(await ensureModuleWithLessons(context, course.id, moduleData))
   }
   if (course.status === 'draft') await publishCourseService(actorId, course.id)
   return { id: course.id, modules }
}

const teacherPermissions = {
   all: { canEditCourse: true, canManageLessons: true, canManageQuestions: true, canManageTests: true, canViewResults: true },
   content: { canEditCourse: true, canManageLessons: true, canManageQuestions: false, canManageTests: false, canViewResults: false },
   assessment: { canEditCourse: false, canManageLessons: false, canManageQuestions: true, canManageTests: true, canViewResults: true },
   results: { canEditCourse: false, canManageLessons: false, canManageQuestions: false, canManageTests: false, canViewResults: true },
}

const courseTeachers = [
   { course: 'bio', teacher: 'teacher', permissions: 'all' },
   { course: 'chem', teacher: 'teacher', permissions: 'content' },
   { course: 'chem', teacher: 'teacher2', permissions: 'all' },
   { course: 'phys', teacher: 'teacher3', permissions: 'assessment' },
   { course: 'math', teacher: 'teacher2', permissions: 'assessment' },
   { course: 'math', teacher: 'teacher3', permissions: 'results' },
]

async function ensureCourseTeachers(context, courses) {
   const { actorId, userIds, note, createOnce } = context
   for (const plan of courseTeachers) {
      const courseId = courses.get(plan.course).id
      const result = await createOnce(
         () => addCourseTeacherService(actorId, courseId, {
            userId: userIds[plan.teacher],
            ...teacherPermissions[plan.permissions],
         }),
         ['COURSE_TEACHER_ALREADY_ASSIGNED'],
      )
      note('course teacher', `${plan.course} / ${plan.teacher} (${plan.permissions})`, result.created)
   }
}

// ---------------------------------------------------------------- question banks

async function ensureQuestionFlow(context, bankId, taxonomy, definition, externalId, existing) {
   const { actorId, note } = context
   let question = existing
   const created = !question
   if (!question) {
      question = await createQuestionService(actorId, bankId, {
         externalId,
         questionType: definition.questionType,
         languageCode: definition.languageCode,
         difficulty: definition.difficulty,
         difficultySource: 'expert',
         content: definition.content,
         ...(definition.interactionSettings ? { interactionSettings: definition.interactionSettings } : {}),
         ...(definition.options ? { options: definition.options } : {}),
         ...(definition.matching ? { matching: definition.matching } : {}),
         topicIds: definition.topics.map((code) => taxonomy.topicIds.get(code)),
      })
   }
   // A rerun after an interrupted run resumes at the first unfinished step.
   if (definition.status !== 'draft' && question.status === 'draft') {
      let keyStatus = question.keyStatus
      if (keyStatus === 'unknown') {
         await replaceAnswerKeyService(actorId, question.id, {
            answerData: definition.answerData,
            source: 'expert_review',
            explanation: definition.explanation,
         })
         keyStatus = 'proposed'
      }
      if (keyStatus === 'proposed') {
         await verifyAnswerKeyService(actorId, question.id, { source: 'expert_review' })
      }
      await publishQuestionService(actorId, question.id)
      if (definition.status === 'archived') await archiveQuestionService(actorId, question.id)
   }
   note(`question (${definition.status})`, externalId, created)
   return question.id
}

async function ensureBank(context, subjectCode, subject) {
   const { actorId, note, createOnce } = context
   const data = bankCatalog[subjectCode]
   const taxonomy = subject
   const createdBank = await createOnce(
      () => createQuestionBankService(actorId, {
         code: data.bankCode,
         title: data.bankTitle,
         subjectId: subject.id,
         visibility: data.visibility,
      }),
      ['QUESTION_BANK_CODE_CONFLICT'],
   )
   let bank = createdBank.value
   if (!bank) {
      const { banks } = await listQuestionBanksService(actorId, { limit: '100' })
      bank = banks.find((item) => item.code === data.bankCode)
   }
   note('question bank', data.bankCode, createdBank.created)

   const { questions } = await listBankQuestionsService(actorId, bank.id, { limit: '100' })
   const publishedIds = []
   for (const [index, definition] of data.questions.entries()) {
      const externalId = `${data.prefix}-${String(index + 1).padStart(2, '0')}`
      const existing = questions.find((item) => item.externalId === externalId)
      const id = await ensureQuestionFlow(context, bank.id, taxonomy, definition, externalId, existing)
      if (definition.status === 'published') publishedIds.push(id)
   }
   return publishedIds
}

// ---------------------------------------------------------------- groups

async function ensureAnnouncements(context, groupId, definitions) {
   const { actorId, note } = context
   const { announcements } = await listGroupAnnouncementsService(actorId, groupId, { limit: '100' })
   for (const definition of definitions) {
      const exists = announcements.some((item) => item.title === definition.title)
      if (!exists) {
         const created = await createGroupAnnouncementService(actorId, groupId, {
            title: definition.title,
            content: definition.content,
            isPinned: definition.isPinned === true,
            status: definition.status === 'draft' ? 'draft' : 'published',
         })
         if (definition.status === 'archived') await archiveGroupAnnouncementService(actorId, groupId, created.id)
      }
      note('announcement', definition.title, !exists)
   }
}

async function ensureGroupMembers(context, groupId, label, members) {
   const { actorId, userIds, note, createOnce } = context
   for (const member of members) {
      const result = await createOnce(
         () => addGroupMemberService(actorId, groupId, {
            userId: userIds[member.student],
            isRepresentative: member.representative === true,
         }),
         ['GROUP_MEMBER_ALREADY_ACTIVE'],
      )
      note('group member', `${label} / ${member.student}`, result.created)
   }
}

async function ensureGroupTeachers(context, groupId, label, teachers) {
   const { actorId, userIds, note, createOnce } = context
   for (const teacher of teachers) {
      const result = await createOnce(
         () => addGroupTeacherService(actorId, groupId, { userId: userIds[teacher.teacher], ...teacher.permissions }),
         ['GROUP_TEACHER_ALREADY_ASSIGNED'],
      )
      note('group teacher', `${label} / ${teacher.teacher}`, result.created)
   }
}

const groupAAnnouncements = [
   { title: 'Черновик: изменения в расписании', content: 'Занятие по биологии в четверг переносится на 17:00. Объявление ещё не опубликовано.', status: 'draft' },
   { title: 'Домашнее задание на неделю', content: 'Повторите параграфы о строении клетки и подготовьтесь к тесту по биологии. Тест открыт до конца следующей недели.' },
]

const groupB = {
   code: 'demo-group-b',
   name: 'Группа Б — подготовка к НЦТ',
   description: 'Вечерняя группа для подготовки к национальному тестированию по математике и химии.',
   members: [
      { student: 'student3', representative: true },
      { student: 'student4' },
      { student: 'student6' },
      { student: 'student7' },
      { student: 'student8' },
      { student: 'student9' },
      { student: 'student10' },
      { student: 'student11' },
   ],
   teachers: [
      { teacher: 'teacher2', permissions: { canPublishAnnouncements: true, canAssignTests: true, canViewResults: true } },
      { teacher: 'teacher3', permissions: { canPublishAnnouncements: false, canAssignTests: false, canViewResults: true } },
   ],
   announcements: [
      { title: 'Правила пробного тестирования', content: 'Тест проходит на компьютере, время ограничено. Телефоны и учебники нужно убрать. Результаты станут доступны после закрытия окна теста.', isPinned: true },
      { title: 'Расписание занятий на ноябрь', content: 'Занятия проходят по вторникам и пятницам в 18:00. Математика — по вторникам, химия — по пятницам.' },
      { title: 'Домашнее задание по алгебре', content: 'Решите двадцать задач на квадратные уравнения из рабочей тетради. Сдайте до пятницы.' },
      { title: 'Черновик: пересдача пробного теста', content: 'Дата пересдачи будет объявлена позже. Это объявление пока скрыто от студентов.', status: 'draft' },
   ],
}

const groupC = {
   code: 'demo-group-c-2025',
   name: 'Группа В — выпуск 2025 (архив)',
   description: 'Завершённая группа прошлого набора, оставлена в архиве для примера.',
   members: [
      { student: 'student12', representative: true },
      { student: 'student13' },
      { student: 'student14' },
   ],
   teachers: [
      { teacher: 'teacher3', permissions: { canPublishAnnouncements: false, canAssignTests: false, canViewResults: true } },
   ],
   announcements: [
      { title: 'Итоги курса', content: 'Спасибо за работу! Все студенты группы успешно завершили курс. Сертификаты выдаются в офисе.', isPinned: true },
      { title: 'Объявление о пересдаче (устарело)', content: 'Пересдача состоялась. Объявление перенесено в архив.', status: 'archived' },
      { title: 'Черновик: поздравление выпускников', content: 'Текст поздравления в работе.', status: 'draft' },
   ],
}

async function findGroup(context, code) {
   const { actorId } = context
   for (const status of ['active', 'archived']) {
      const listed = await listGroupsService(actorId, { status, limit: '100' })
      const group = listed.groups.find((item) => item.code === code)
      if (group) return group
   }
   return null
}

async function ensureExtraGroup(context, data, { archive }) {
   const { actorId, note } = context
   let group = await findGroup(context, data.code)
   const created = !group
   note('group', data.code, created)
   // An archived group cannot take members or announcements, so a finished one is left alone.
   if (group?.status === 'archived') return group.id
   if (!group) {
      group = await createGroupService(actorId, {
         code: data.code,
         name: data.name,
         description: data.description,
      })
   }
   await ensureGroupMembers(context, group.id, data.code, data.members)
   await ensureGroupTeachers(context, group.id, data.code, data.teachers)
   await ensureAnnouncements(context, group.id, data.announcements)
   if (archive) await updateGroupService(actorId, group.id, { status: 'archived' })
   return group.id
}

async function ensureGroups(context, groupAId) {
   const { actorId, userIds } = context
   // Group A comes from the original seed; it gains a representative and more announcements.
   const members = await listGroupMembersService(actorId, groupAId, { limit: '100' })
   const representative = members.members.find((member) => member.id === userIds.student1)
   if (representative && representative.role !== 'representative') {
      await updateGroupMemberService(actorId, groupAId, userIds.student1, { isRepresentative: true })
   }
   await ensureAnnouncements(context, groupAId, groupAAnnouncements)
   const groupBId = await ensureExtraGroup(context, groupB, { archive: false })
   const groupCId = await ensureExtraGroup(context, groupC, { archive: true })
   return { a: groupAId, b: groupBId, c: groupCId }
}

// ---------------------------------------------------------------- access

// Module grant windows. Past windows use the services' own clock parameter, because the API
// refuses to create an access window that has already ended.
const moduleStates = {
   active: { body: () => ({ expiresAt: null }) },
   ending: { body: () => ({ expiresAt: at(3) }) },
   scheduled: { body: () => ({ beginsAt: at(7), expiresAt: at(60) }) },
   expired: {
      body: () => ({ beginsAt: at(-40), expiresAt: at(-10) }),
      overrides: () => ({ clock: () => new Date(at(-40)) }),
   },
   revoked: { body: () => ({ expiresAt: null }), revoke: true },
}

async function ensureModuleGrants(context, courseId, studentId, label, grants, modules) {
   const { actorId, note } = context
   const { moduleGrants } = await listModuleAccessGrantsService(actorId, courseId, studentId)
   for (const grant of grants) {
      const module = modules[grant.module]
      const exists = moduleGrants.some((item) => item.moduleId === module.id && item.state !== 'revoked')
      const state = moduleStates[grant.state]
      if (!exists) {
         await grantModuleAccessService(
            actorId,
            courseId,
            studentId,
            { moduleId: module.id, ...state.body() },
            state.overrides?.(),
         )
         if (state.revoke) await revokeModuleAccessService(actorId, courseId, studentId, module.id)
      }
      note('module grant', `${label} / ${grant.state} / module ${grant.module + 1}`, !exists)
   }
}

const enrollmentKinds = {
   active: (days) => ({ expiresAt: days ? at(days) : null }),
   scheduled: (days) => ({ beginsAt: at(7), expiresAt: at(days) }),
}

// student, course, kind of enrollment, and the module grants to give inside it.
const accessPlans = [
   { student: 'student1', course: 'bio', kind: 'active', grants: [{ module: 0, state: 'active' }, { module: 1, state: 'active' }] },
   { student: 'student1', course: 'chem', kind: 'active', days: 90, grants: [{ module: 0, state: 'active' }, { module: 1, state: 'ending' }] },
   { student: 'student2', course: 'bio', kind: 'scheduled', days: 180, grants: [{ module: 0, state: 'scheduled' }] },
   { student: 'student2', course: 'math', kind: 'active', days: 60, grants: [{ module: 0, state: 'active' }, { module: 1, state: 'active' }, { module: 2, state: 'ending' }] },
   { student: 'student3', course: 'bio', kind: 'expired', grants: [{ module: 0, state: 'expired' }, { module: 1, state: 'active' }] },
   { student: 'student3', course: 'phys', kind: 'active', grants: [{ module: 0, state: 'active' }, { module: 1, state: 'revoked' }] },
   { student: 'student4', course: 'chem', kind: 'revoked', days: 90, grants: [{ module: 0, state: 'active' }] },
   { student: 'student4', course: 'math', kind: 'reinstated', days: 120, grants: [{ module: 0, state: 'active' }, { module: 1, state: 'active' }], regrant: [0] },
   { student: 'student5', course: 'phys', kind: 'active', grants: [{ module: 0, state: 'active' }, { module: 1, state: 'active' }, { module: 2, state: 'active' }] },
   { student: 'student5', course: 'math', kind: 'scheduled', days: 120, grants: [] },
]

async function ensureAccess(context, courses) {
   const { actorId, userIds, note, collectPages } = context
   const enrollmentsByCourse = new Map()
   for (const plan of accessPlans) {
      const course = courses.get(plan.course)
      const studentId = userIds[plan.student]
      if (!enrollmentsByCourse.has(plan.course)) {
         enrollmentsByCourse.set(plan.course, await collectPages(
            (query) => listCourseEnrollmentsService(actorId, course.id, query),
            (page) => page.enrollments,
         ))
      }
      const label = `${plan.student} / ${plan.course} / ${plan.kind}`
      const exists = enrollmentsByCourse.get(plan.course).some((item) => item.userId === studentId)
      note('enrollment', label, !exists)
      if (exists) continue

      const modules = course.modules
      if (plan.kind === 'expired') {
         // Enrollment opened 40 days ago, grants made while it was current, then it ended.
         const past = { clock: () => new Date(at(-40)) }
         await grantCourseEnrollmentService(actorId, course.id, { userId: studentId, beginsAt: at(-40), expiresAt: null }, past)
         await ensureModuleGrants(context, course.id, studentId, label, plan.grants, modules)
         await extendCourseEnrollmentService(
            actorId,
            course.id,
            studentId,
            { expiresAt: at(-5) },
            { clock: () => new Date(at(-6)) },
         )
         continue
      }
      const body = enrollmentKinds[plan.kind === 'scheduled' ? 'scheduled' : 'active'](plan.days)
      await grantCourseEnrollmentService(actorId, course.id, { userId: studentId, ...body })
      await ensureModuleGrants(context, course.id, studentId, label, plan.grants, modules)
      if (plan.kind === 'revoked' || plan.kind === 'reinstated') {
         await revokeCourseEnrollmentService(actorId, course.id, studentId)
      }
      if (plan.kind === 'reinstated') {
         // Granting a revoked enrollment again reinstates it; its module grants stay revoked.
         await grantCourseEnrollmentService(actorId, course.id, { userId: studentId, expiresAt: at(plan.days) })
         await ensureModuleGrants(
            context,
            course.id,
            studentId,
            `${label} / regrant`,
            plan.regrant.map((module) => ({ module, state: 'active' })),
            modules,
         )
      }
   }
}

// ---------------------------------------------------------------- tests

const points = ['1', '1', '2', '1', '3', '2', '1', '2', '1', '1.5', '2', '1', '3', '2', '5']

const open = { opensAt: () => at(-1), closesAt: () => at(14) }
const upcoming = { opensAt: () => at(3), closesAt: () => at(10) }
const openEnded = { opensAt: () => at(-2), closesAt: () => null }
// Closed windows cannot be created (closesAt must be in the future); they are created open
// and then moved into the past with the assignment update API.
const closed = { opensAt: () => at(-10), closesAt: () => at(-3), closesAtOnCreate: () => at(0.01) }

const testCatalog = [
   {
      title: 'Биология 9: клетка и её строение',
      course: 'bio',
      bank: 'demo-biology',
      from: 0,
      count: 10,
      lesson: { module: 0, title: 'Тест: клетка и её строение', tgTitle: 'Тест: ҳуҷайра ва сохтори он' },
      settings: { mode: 'practice', timeLimitMinutes: 20, maxAttempts: 3, resultPolicy: 'best', answerRevealPolicy: 'after_submission', shuffleQuestions: true, shuffleOptions: true, passPercent: 60 },
      assignments: [{ group: 'a', window: open }, { user: 'student1', window: open }],
   },
   {
      title: 'Химия 9: периодический закон и реакции',
      course: 'chem',
      bank: 'demo-chemistry',
      from: 0,
      count: 15,
      lesson: { module: 1, title: 'Контрольный тест по химии', tgTitle: 'Санҷиши назоратӣ аз химия' },
      settings: { mode: 'exam', timeLimitMinutes: 30, maxAttempts: 1, resultPolicy: 'first', answerRevealPolicy: 'after_window', shuffleQuestions: false, shuffleOptions: true, passPercent: 70 },
      assignments: [{ group: 'b', window: upcoming }, { user: 'student1', window: open }],
   },
   {
      title: 'Физика 9: механика',
      course: 'phys',
      bank: 'demo-physics',
      from: 0,
      count: 10,
      lesson: { module: 0, title: 'Тест по механике', tgTitle: 'Тест аз механика' },
      settings: { mode: 'lesson', timeLimitMinutes: null, maxAttempts: 5, resultPolicy: 'best', answerRevealPolicy: 'after_submission', shuffleQuestions: false, shuffleOptions: false, passPercent: 50 },
      assignments: [{ group: 'a', window: closed }, { user: 'student5', window: openEnded }, { user: 'student3', window: upcoming }],
   },
   {
      title: 'Математика: пробный тест НЦТ',
      course: 'math',
      bank: 'demo-math',
      from: 0,
      count: 15,
      lesson: { module: 2, title: 'Пробный тест НЦТ', tgTitle: 'Тести озмоишӣ' },
      settings: { mode: 'exam', timeLimitMinutes: 45, maxAttempts: 2, resultPolicy: 'last', answerRevealPolicy: 'never', shuffleQuestions: true, shuffleOptions: true, passPercent: 55 },
      assignments: [{ group: 'b', window: open }, { user: 'student2', window: closed }, { user: 'student4', window: open }],
   },
   {
      title: 'Биология 9: генетика (черновик)',
      course: 'bio',
      bank: 'demo-biology',
      from: 10,
      count: 6,
      status: 'draft',
      settings: { mode: 'practice', timeLimitMinutes: 15, maxAttempts: 2, resultPolicy: 'last', answerRevealPolicy: 'after_submission', shuffleQuestions: false, shuffleOptions: false, passPercent: 60 },
      assignments: [],
   },
   {
      title: 'Физика 9: входной тест (архив)',
      course: 'phys',
      bank: 'demo-physics',
      from: 10,
      count: 5,
      status: 'archived',
      settings: { mode: 'practice', timeLimitMinutes: 10, maxAttempts: 1, resultPolicy: 'first', answerRevealPolicy: 'after_submission', shuffleQuestions: false, shuffleOptions: false, passPercent: null },
      assignments: [],
   },
]

async function ensureAssignment(context, test, assignment, groupIds) {
   const { actorId, userIds, note } = context
   const audience = assignment.group
      ? { groupId: groupIds[assignment.group] }
      : { userId: userIds[assignment.user] }
   const { assignments } = await listAssignmentsService(actorId, test.id, { limit: '100' })
   const exists = assignments.some((item) => (
      audience.groupId ? item.groupId === audience.groupId : item.userId === audience.userId
   ))
   const window = assignment.window
   if (!exists) {
      const created = await createAssignmentService(actorId, test.id, {
         ...audience,
         opensAt: window.opensAt(),
         closesAt: (window.closesAtOnCreate || window.closesAt)(),
      })
      if (window.closesAtOnCreate) {
         await updateAssignmentService(actorId, test.id, created.id, {
            opensAt: window.opensAt(),
            closesAt: window.closesAt(),
         })
      }
   }
   note('test assignment', `${test.title} / ${assignment.group ? `group ${assignment.group}` : assignment.user}`, !exists)
}

// A published test lesson at the end of a module, linked to the published demo test.
async function ensureTestLesson(context, course, testId, definition) {
   const { actorId, note } = context
   const moduleId = course.modules[definition.module].id
   const { lessons } = await listModuleLessonsService(actorId, course.id, moduleId)
   let lesson = lessons.find((item) => item.title === definition.title)
   const created = !lesson
   if (!lesson) {
      lesson = await createLessonService(actorId, course.id, moduleId, {
         title: definition.title,
         lessonType: 'test',
         testId,
         content: { blocks: [{ type: 'paragraph', text: 'Проверьте себя: тест открывается в назначенное окно.' }] },
         translations: { tg: { title: definition.tgTitle } },
      })
   }
   if (lesson.status === 'draft') await publishLessonService(actorId, course.id, lesson.id)
   note('test lesson', definition.title, created)
}

async function ensureTests(context, courses, bankQuestionIds, groupIds) {
   const { actorId, note } = context
   for (const plan of testCatalog) {
      const course = courses.get(plan.course)
      const { tests } = await listTestsService(actorId, { courseId: course.id, limit: '100' })
      let test = tests.find((item) => item.title === plan.title)
      const created = !test
      if (!test) {
         test = await createTestService(actorId, { courseId: course.id, title: plan.title, ...plan.settings })
      }
      note(`test (${plan.status || 'published'})`, plan.title, created)

      if (test.status === 'draft') {
         const { questions } = await getTestService(actorId, test.id)
         if (!questions.length) {
            const ids = bankQuestionIds.get(plan.bank).slice(plan.from, plan.from + plan.count)
            await addTestQuestionsService(actorId, test.id, {
               questions: ids.map((questionId, index) => ({ questionId, points: points[index % points.length] })),
            })
         }
         if (plan.status !== 'draft') {
            test = await publishTestService(actorId, test.id)
         }
      }
      if (test.status === 'published') {
         for (const assignment of plan.assignments) await ensureAssignment(context, test, assignment, groupIds)
         if (plan.lesson) await ensureTestLesson(context, course, test.id, plan.lesson)
         if (plan.status === 'archived') await archiveTestService(actorId, test.id)
      }
   }
}

// ---------------------------------------------------------------- entry point

// Creates the taxonomy and returns the subject map; the original seed uses it for its own
// biology and chemistry content so no duplicate subjects appear.
export { ensureTaxonomy }

export async function seedRichDemoContent(context, { subjects, groupAId }) {
   const courses = new Map()
   for (const data of courseCatalog) {
      const course = await ensureCourse(context, data, subjects.get(data.subjectCode).id)
      courses.set(data.key, course)
   }
   await ensureCourseTeachers(context, courses)

   const bankQuestionIds = new Map()
   for (const [code, subject] of subjects) {
      bankQuestionIds.set(code, await ensureBank(context, code, subject))
   }

   const groupIds = await ensureGroups(context, groupAId)
   await ensureAccess(context, courses)
   await ensureTests(context, courses, bankQuestionIds, groupIds)
}
