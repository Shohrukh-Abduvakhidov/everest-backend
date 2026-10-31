// OpenAPI 3.1 description of every /api/v1 route. Paths are written in Express syntax
// (`:param`) so the coverage test can compare them with the registered routes directly.
// Each operation is declared once through `operation()`, which derives path parameters,
// security, CSRF, rate-limit and error responses from a few flags.

const languages = ['tg', 'ru', 'en']

const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
const str = (extra = {}) => ({ type: 'string', ...extra })
const int = (extra = {}) => ({ type: 'integer', ...extra })
const bool = (extra = {}) => ({ type: 'boolean', ...extra })
const num = (extra = {}) => ({ type: 'number', ...extra })
const dt = () => ({ type: 'string', format: 'date-time' })
const id = () => ref('Id')
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra })
const anyObject = (description) => ({ type: 'object', ...(description ? { description } : {}) })
const enumOf = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })

function nullable(schema) {
   if (schema.$ref || !schema.type) return { anyOf: [schema, { type: 'null' }] }
   return { ...schema, type: [schema.type, 'null'] }
}

function obj(properties, required = [], { strict = false, description } = {}) {
   return {
      type: 'object',
      ...(description ? { description } : {}),
      properties,
      ...(required.length ? { required } : {}),
      ...(strict ? { additionalProperties: false } : {}),
   }
}

// Request bodies reject unknown fields, so they are declared strict.
const body = (properties, required = [], description) => obj(properties, required, { strict: true, description })

const pagination = ref('Pagination')
const page = (key, item) => obj({ [key]: arr(item), pagination }, [key, 'pagination'])
const deleted = () => obj({ id: id(), status: str({ const: 'deleted' }) }, ['id', 'status'])

const schemas = {
   Id: str({
      pattern: '^[1-9][0-9]*$',
      description: 'Canonical positive decimal string (PostgreSQL BIGINT). Never coerce to Number.',
      examples: ['42'],
   }),
   ErrorResponse: obj({
      error: obj({
         code: str({ description: 'Stable machine-readable error code' }),
         message: str(),
         details: arr(anyObject('Field or reason detail, e.g. { field, message }')),
      }, ['code', 'message', 'details']),
   }, ['error']),
   Pagination: obj({ limit: int(), offset: int(), hasMore: bool() }, ['limit', 'offset', 'hasMore']),
   LanguageCode: enumOf(languages),
   TitleTranslations: {
      type: 'object',
      description: 'Optional map tg|ru|en → { title }',
      propertyNames: enumOf(languages),
      additionalProperties: body({ title: str({ minLength: 1, maxLength: 200 }) }, ['title']),
   },
   CourseTranslations: {
      type: 'object',
      description: 'Optional map tg|ru|en → { title?, description? }',
      propertyNames: enumOf(languages),
      additionalProperties: body({ title: str(), description: nullable(str()) }),
   },
   RichContent: obj({
      blocks: arr(obj({ type: str() }, ['type']), { maxItems: 200 }),
   }, ['blocks'], { description: 'Content blocks; the allowed block types depend on the resource (see docs/api.md).' }),
   AuthResult: obj({
      status: enumOf(['authenticated', 'refreshed']),
      expiresAt: dt(),
      refreshExpiresAt: dt(),
      sessionId: id(),
      user: obj({ id: id() }, ['id']),
   }, ['status', 'expiresAt'], { description: 'Tokens are never in JSON; they are set as cookies.' }),
   StatusResult: obj({ status: str() }, ['status']),
   Session: obj({
      id: id(),
      createdAt: dt(),
      lastUsedAt: nullable(dt()),
      expiresAt: dt(),
      revokedAt: nullable(dt()),
      current: bool(),
      device: obj({ browser: str(), operatingSystem: str(), deviceType: str() }),
   }),
   Onboarding: obj({
      state: enumOf(['incomplete', 'completed']),
      completedSteps: arr(str()),
      missingRequiredFields: arr(str()),
      canComplete: bool(),
      completedAt: nullable(dt()),
   }),
   Profile: obj({
      id: id(),
      firstName: nullable(str()),
      lastName: nullable(str()),
      displayName: nullable(str()),
      phone: nullable(str()),
      telegramLinked: bool(),
      avatarAssetId: nullable(id()),
      status: str(),
      roles: arr(str()),
      preferredLanguage: enumOf(['ru', 'tj', 'en']),
      timezone: nullable(str()),
      onboarding: ref('Onboarding'),
      createdAt: dt(),
      updatedAt: dt(),
   }),
   PendingUser: obj({
      id: id(),
      status: str(),
      firstName: nullable(str()),
      lastName: nullable(str()),
      phone: nullable(str()),
      createdAt: dt(),
      onboardingCompletedAt: nullable(dt()),
   }),
   AccountTransition: obj({
      action: enumOf(['approve', 'reject', 'block', 'unblock']),
      user: ref('PendingUser'),
      revokedSessions: int({ description: 'Only for block' }),
   }),
   GroupRelationship: obj({ member: bool(), representative: bool(), teacher: bool(), administrator: bool() }),
   Group: obj({
      id: id(),
      code: str(),
      name: str(),
      description: nullable(str()),
      status: enumOf(['active', 'archived']),
      memberCount: int(),
      teacherCount: int(),
      relationship: ref('GroupRelationship'),
      createdAt: dt(),
      updatedAt: dt(),
   }),
   GroupMember: obj({
      id: id(),
      firstName: nullable(str()),
      lastName: nullable(str()),
      avatarAssetId: nullable(id()),
      role: enumOf(['member', 'representative']),
      status: str(),
      joinedAt: dt(),
   }),
   GroupTeacherPermissions: obj({ publishAnnouncements: bool(), assignTests: bool(), viewResults: bool() }),
   GroupTeacher: obj({
      id: id(),
      firstName: nullable(str()),
      lastName: nullable(str()),
      avatarAssetId: nullable(id()),
      role: str({ const: 'teacher' }),
      assignedAt: dt(),
      permissions: ref('GroupTeacherPermissions'),
   }),
   Announcement: obj({
      id: id(),
      groupId: id(),
      authorId: id(),
      title: str(),
      content: str({ description: 'Plain text' }),
      isPinned: bool(),
      status: enumOf(['draft', 'published', 'archived']),
      publishedAt: nullable(dt()),
      createdAt: dt(),
      updatedAt: dt(),
   }),
   Course: obj({
      id: id(),
      subjectId: nullable(id()),
      title: str(),
      description: nullable(str()),
      languageCode: ref('LanguageCode'),
      translations: ref('CourseTranslations'),
      coverAssetId: nullable(id()),
      status: enumOf(['draft', 'published', 'archived']),
      creatorId: id(),
      relationship: obj({ administrator: bool(), teacher: bool(), canEdit: bool() }),
      createdAt: dt(),
      updatedAt: dt(),
   }),
   CourseTeacher: obj({
      id: id(),
      firstName: nullable(str()),
      lastName: nullable(str()),
      avatarAssetId: nullable(id()),
      permissions: obj({
         editCourse: bool(),
         manageLessons: bool(),
         manageQuestions: bool(),
         manageTests: bool(),
         viewResults: bool(),
      }),
   }),
   CourseModule: obj({
      id: id(),
      courseId: id(),
      title: str(),
      description: nullable(str()),
      translations: ref('CourseTranslations'),
      position: int(),
      status: enumOf(['draft', 'published', 'archived']),
      createdAt: dt(),
   }),
   PreviewModule: obj({
      id: id(),
      title: str(),
      description: nullable(str()),
      position: int(),
      status: str(),
      lessonsCount: int(),
      testsCount: int(),
   }),
   GrantWindow: obj({
      state: enumOf(['active', 'scheduled', 'expired', 'revoked']),
      grantedBy: id(),
      grantedAt: dt(),
      beginsAt: dt(),
      expiresAt: nullable(dt()),
      revokedAt: nullable(dt()),
      revokedBy: nullable(id()),
   }),
   Enrollment: {
      allOf: [ref('GrantWindow'), obj({
         id: id(),
         userId: id(),
         courseId: id(),
         user: obj({ firstName: nullable(str()), lastName: nullable(str()) }, [], { description: 'Lists only' }),
      })],
   },
   ModuleGrant: {
      allOf: [ref('GrantWindow'), obj({
         id: id(),
         userId: id(),
         courseId: id(),
         moduleId: id(),
         moduleTitle: str({ description: 'Lists only' }),
      })],
   },
   SubjectCard: obj({
      id: id(),
      title: nullable(str()),
      translations: ref('TitleTranslations'),
      color: enumOf(['green', 'blue', 'orange', 'purple', 'neutral']),
   }),
   EnrollmentWindow: obj({
      state: enumOf(['active', 'scheduled', 'expired']),
      beginsAt: dt(),
      expiresAt: nullable(dt()),
   }),
   LearnerCourse: obj({
      id: id(),
      title: str(),
      description: nullable(str()),
      languageCode: ref('LanguageCode'),
      translations: ref('CourseTranslations'),
      coverAssetId: nullable(id()),
      subject: nullable(ref('SubjectCard')),
      moduleCount: int(),
      lessonCount: int(),
      enrollment: ref('EnrollmentWindow'),
   }),
   LearnerModule: obj({
      id: id(),
      position: int(),
      title: str(),
      description: nullable(str()),
      translations: ref('CourseTranslations'),
      access: obj({
         granted: bool(),
         lockReason: nullable(enumOf(['onboarding_required', 'not_started', 'expired', 'not_granted', 'unavailable'])),
      }),
   }),
   Chapter: obj({
      id: id(),
      startSeconds: int(),
      title: str(),
      translations: ref('TitleTranslations'),
      position: int(),
   }),
   LessonVideo: obj({
      assetId: id(),
      mimeType: str(),
      durationSeconds: nullable(int()),
      widthPx: nullable(int()),
      heightPx: nullable(int()),
      sizeBytes: int(),
      playable: bool(),
   }),
   LessonResource: obj({
      id: id(),
      assetId: id(),
      title: nullable(str()),
      position: int(),
      fileName: nullable(str()),
      mimeType: str(),
      sizeBytes: int(),
   }),
   LessonSummary: obj({
      id: id(),
      moduleId: id(),
      courseId: id(),
      title: str(),
      position: int(),
      lessonType: enumOf(['video', 'text', 'test', 'mixed']),
      translations: ref('TitleTranslations'),
      videoAssetId: nullable(id()),
      allowOffline: bool(),
      status: enumOf(['draft', 'published', 'archived']),
      createdAt: dt(),
      updatedAt: dt(),
   }),
   LessonDetail: {
      allOf: [ref('LessonSummary'), obj({
         content: ref('RichContent'),
         video: nullable(ref('LessonVideo')),
         chapters: arr(ref('Chapter')),
         resources: arr(ref('LessonResource')),
         relationship: obj({ canManage: bool() }),
      })],
   },
   Progress: obj({
      status: str({ examples: ['not_started', 'in_progress', 'completed'] }),
      playbackSeconds: int(),
      watchedSeconds: int(),
      completedAt: nullable(dt()),
      revision: int(),
      updatedAt: dt(),
   }),
   LearnerLesson: obj({
      id: id(),
      moduleId: id(),
      title: str(),
      position: int(),
      lessonType: str(),
      translations: ref('TitleTranslations'),
      access: obj({ granted: bool() }),
      content: ref('RichContent'),
      allowOffline: bool(),
      video: nullable(obj({ durationSeconds: nullable(int()), playable: bool() })),
      chapters: arr(ref('Chapter')),
      resources: arr(obj({
         id: id(), title: nullable(str()), position: int(), fileName: nullable(str()), mimeType: str(), sizeBytes: int(),
      })),
      progress: ref('Progress'),
   }, ['id', 'access'], { description: 'Without access only the summary fields are present.' }),
   Note: obj({
      id: id(),
      lessonId: id(),
      body: str(),
      playbackSeconds: nullable(int()),
      createdAt: dt(),
      updatedAt: dt(),
   }),
   SignedUrl: obj({
      url: str({ format: 'uri', description: 'Short-lived presigned storage URL' }),
      expiresAt: dt(),
      fileName: str(),
      mimeType: str(),
      sizeBytes: int(),
      durationSeconds: nullable(int()),
   }),
   OfflineLicense: obj({
      id: id(),
      courseId: id(),
      lessonId: id(),
      status: enumOf(['active', 'expired', 'revoked']),
      grantedAt: dt(),
      renewedAt: nullable(dt()),
      lastCheckedAt: nullable(dt()),
      leaseExpiresAt: dt(),
      deviceLabel: nullable(str()),
      revokeReason: nullable(enumOf(['user_deleted', 'admin_revoked', 'access_lost'])),
      sessionId: id(),
   }),
   Upload: obj({
      id: id(),
      assetId: id(),
      courseId: id(),
      kind: enumOf(['video', 'material']),
      fileName: str(),
      mimeType: str(),
      sizeBytes: int(),
      partSizeBytes: int(),
      partCount: int(),
      status: enumOf(['initiated', 'completed', 'aborted', 'rejected', 'expired']),
      rejectionCode: nullable(str()),
      createdAt: dt(),
      expiresAt: dt(),
      completedAt: nullable(dt()),
      abortedAt: nullable(dt()),
   }),
   Asset: obj({
      id: id(),
      kind: str(),
      mimeType: str(),
      fileName: nullable(str()),
      sizeBytes: int(),
      widthPx: nullable(int()),
      heightPx: nullable(int()),
      durationSeconds: nullable(int()),
      status: str(),
      processingStatus: enumOf(['none', 'not_required', 'pending', 'processing', 'completed', 'failed']),
      processingError: nullable(str()),
      createdAt: dt(),
   }),
   Subject: obj({
      id: id(),
      code: str(),
      primaryLanguage: ref('LanguageCode'),
      title: nullable(str()),
      translations: ref('TitleTranslations'),
      color: enumOf(['green', 'blue', 'orange', 'purple', 'neutral']),
   }),
   Section: obj({
      id: id(),
      subjectId: id(),
      code: str(),
      primaryLanguage: ref('LanguageCode'),
      title: nullable(str()),
      translations: ref('TitleTranslations'),
   }),
   Topic: obj({
      id: id(),
      subjectId: id(),
      sectionId: nullable(id()),
      parentId: nullable(id()),
      code: str(),
      primaryLanguage: ref('LanguageCode'),
      title: nullable(str()),
      translations: ref('TitleTranslations'),
   }),
   SourceMetadata: body({
      book: str(), edition: str(), page: int({ minimum: 1 }), number: str(), note: str(),
      year: int({ minimum: 1900, maximum: 2100 }), sourceFile: str(), printedPage: str(), sequence: int({ minimum: 1 }),
      bookSectionTitle: str(), bookRubric: str(), isSample: bool(), reviewRequired: bool(),
      examPart: arr(str({ maxLength: 20 }), { minItems: 1, maxItems: 10 }),
   }),
   QuestionBank: obj({
      id: id(),
      code: str(),
      title: str(),
      subjectId: id(),
      ownerId: id(),
      visibility: enumOf(['private', 'staff']),
      sourceMetadata: ref('SourceMetadata'),
      questionCount: int(),
      permissions: obj({ manage: bool() }),
      createdAt: dt(),
   }),
   QuestionItem: obj({
      key: str({ pattern: '^[A-Za-z0-9_-]{1,20}$' }),
      position: int(),
      sourceLabel: nullable(str()),
      content: ref('RichContent'),
   }),
   QuestionItemInput: body({
      key: str({ pattern: '^[A-Za-z0-9_-]{1,20}$' }),
      content: ref('RichContent'),
      sourceLabel: nullable(str({ maxLength: 50 })),
   }, ['key', 'content'], 'There is no correctness field; correctness lives only in the answer key.'),
   QuestionSummary: obj({
      id: id(),
      externalId: nullable(str()),
      questionType: enumOf(['single_choice', 'multiple_choice', 'matching', 'numeric', 'short_text']),
      languageCode: ref('LanguageCode'),
      difficulty: nullable(int({ minimum: 1, maximum: 5 })),
      difficultySource: nullable(enumOf(['ai', 'expert', 'official'])),
      status: enumOf(['draft', 'published', 'archived']),
      keyStatus: enumOf(['unknown', 'proposed', 'verified']),
      content: ref('RichContent'),
      updatedAt: dt(),
   }),
   AnswerKey: obj({
      status: enumOf(['unknown', 'proposed', 'verified']),
      source: enumOf(['none', 'official_key', 'expert_review', 'ai_inference']),
      answerData: nullable(anyObject('Type-specific: { optionKey } | { optionKeys } | { pairs } | { value } | { acceptedAnswers }')),
      explanation: ref('RichContent'),
      verifiedBy: nullable(id()),
      verifiedAt: nullable(dt()),
   }),
   QuestionImport: obj({
      id: id(),
      bankId: id(),
      bankCode: str(),
      initiatedBy: id(),
      packageSha256: str({ pattern: '^[a-f0-9]{64}$' }),
      schemaVersion: str({ const: 'everest.question-import.v1' }),
      idempotencyKey: str(),
      isDryRun: bool(),
      status: enumOf(['pending', 'validating', 'validated', 'importing', 'completed', 'failed']),
      manifest: anyObject('Package summary: bankCode, sourceNamespace and entity counts (no question text)'),
      counters: anyObject('subjects/sections/topics/bank/assets/questions/answerKeys/duplicates/batches counts'),
      createdAt: dt(),
      finishedAt: nullable(dt()),
   }),
   QuestionImportEntry: obj({
      id: id(),
      externalId: nullable(str()),
      recordPath: nullable(str()),
      severity: enumOf(['warning', 'error']),
      code: str(),
      message: str(),
      createdAt: dt(),
   }),
   QuestionDetail: {
      allOf: [ref('QuestionSummary'), obj({
         bankId: id(),
         subjectId: id(),
         interactionSettings: anyObject('{} or, for matching, { requireAllLeft, allowRightReuse }'),
         sourceMetadata: ref('SourceMetadata'),
         sourceQuestionId: nullable(id()),
         importId: nullable(id()),
         createdBy: id(),
         createdAt: dt(),
         options: arr(ref('QuestionItem')),
         matching: nullable(obj({ left: arr(ref('QuestionItem')), right: arr(ref('QuestionItem')) })),
         topicIds: arr(id()),
         assetIds: arr(id()),
         answerKey: { ...ref('AnswerKey'), description: 'Present only for actors who can manage the bank' },
      })],
   },
}

// --- Reusable request bodies -------------------------------------------------------------

const courseFields = {
   subjectId: nullable(id()),
   title: str({ minLength: 1, maxLength: 200 }),
   description: nullable(str({ maxLength: 5000 })),
   languageCode: ref('LanguageCode'),
   translations: ref('CourseTranslations'),
   coverAssetId: nullable(id()),
}
const moduleFields = {
   title: str({ minLength: 1, maxLength: 200 }),
   description: nullable(str()),
   translations: ref('CourseTranslations'),
}
const lessonFields = {
   title: str({ minLength: 1, maxLength: 200 }),
   lessonType: enumOf(['video', 'text', 'test', 'mixed']),
   content: ref('RichContent'),
   translations: ref('TitleTranslations'),
   videoAssetId: nullable(id()),
   allowOffline: bool(),
}
const teacherFlags = {
   canEditCourse: bool(),
   canManageLessons: bool(),
   canManageQuestions: bool(),
   canManageTests: bool(),
   canViewResults: bool(),
}
const grantBody = (extra = {}, required = []) => body({
   ...extra,
   beginsAt: dt(),
   expiresAt: nullable(dt()),
}, [...required, 'expiresAt'])
const taxonomyFields = (extra = {}) => ({
   code: str({ pattern: '^[a-z0-9][a-z0-9_-]{0,49}$' }),
   primaryLanguage: ref('LanguageCode'),
   translations: ref('TitleTranslations'),
   ...extra,
})
const questionFields = {
   externalId: nullable(str({ maxLength: 200 })),
   languageCode: ref('LanguageCode'),
   difficulty: nullable(int({ minimum: 1, maximum: 5 })),
   difficultySource: nullable(enumOf(['ai', 'expert', 'official'])),
   content: ref('RichContent'),
   interactionSettings: anyObject('{} or, for matching, { requireAllLeft: boolean|null, allowRightReuse: boolean|null } (null = not stated; drafts only)'),
   sourceMetadata: ref('SourceMetadata'),
   options: arr(ref('QuestionItemInput'), { minItems: 2, maxItems: 10 }),
   matching: body({
      left: arr(ref('QuestionItemInput'), { minItems: 1, maxItems: 20 }),
      right: arr(ref('QuestionItemInput'), { minItems: 1, maxItems: 20 }),
   }, ['left', 'right']),
   topicIds: arr(id(), { maxItems: 20, uniqueItems: true }),
}
const announcementFields = {
   title: str({ maxLength: 200 }),
   content: str({ maxLength: 10000 }),
   isPinned: bool(),
   status: enumOf(['draft', 'published']),
}
const profileFields = {
   firstName: nullable(str({ maxLength: 100 })),
   lastName: nullable(str({ maxLength: 100 })),
   preferredLanguage: enumOf(['ru', 'tj', 'en']),
   timezone: str({ description: 'IANA time zone, e.g. Asia/Dushanbe' }),
}

const limitQuery = [
   { name: 'limit', schema: int({ minimum: 1, maximum: 100, default: 20 }) },
   { name: 'offset', schema: int({ minimum: 0, default: 0 }) },
]

// --- Operation builder ---------------------------------------------------------------------

const permissionDescriptions = {
   'accounts.pending.read': 'owner, admin',
   'accounts.approve': 'owner, admin',
   'accounts.reject': 'owner, admin',
   'accounts.block': 'owner, admin',
   'accounts.unblock': 'owner, admin',
}

function errorResponse(description) {
   return { description, content: { 'application/json': { schema: ref('ErrorResponse') } } }
}

function operation(method, path, spec) {
   const params = [...path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => ({
      name,
      in: 'path',
      required: true,
      schema: id(),
   }))
   const auth = spec.auth ?? 'session'
   const mutating = method !== 'get'
   const csrf = spec.csrf ?? (auth === 'session' && mutating)
   const parameters = [
      ...params,
      ...(spec.query || []).map((query) => ({ in: 'query', required: false, ...query })),
      ...(csrf ? [{ $ref: '#/components/parameters/CsrfToken' }] : []),
   ]
   const responses = {
      [spec.status || (method === 'post' && spec.created ? 201 : 200)]: {
         description: spec.responseDescription || 'Success',
         ...(spec.headers ? { headers: spec.headers } : {}),
         ...(spec.response === null ? {} : {
            content: {
               'application/json': {
                  schema: obj({ data: spec.response || anyObject() }, ['data']),
               },
            },
         }),
      },
   }
   const errors = { 400: ['VALIDATION_ERROR'], ...(spec.errors || {}) }
   if (auth === 'session') errors[401] = ['AUTHENTICATION_REQUIRED', ...(errors[401] || [])]
   if (spec.permission) errors[403] = [spec.permissionError || 'ACTION_FORBIDDEN', ...(errors[403] || [])]
   if (csrf) errors[403] = [...(errors[403] || []), 'CSRF_TOKEN_INVALID', 'CSRF_ORIGIN_REJECTED']
   if (spec.rate) errors[429] = ['AUTH_RATE_LIMITED (Retry-After header)']
   for (const [status, codes] of Object.entries(errors)) {
      responses[status] = errorResponse(codes.join(', '))
   }
   const notes = [
      spec.description,
      spec.permission
         ? `Permission: \`${spec.permission}\`${permissionDescriptions[spec.permission] ? ` (${permissionDescriptions[spec.permission]})` : ''}.`
         : null,
      csrf ? 'Cookie sessions must send `X-CSRF-Token` and an allowed `Origin`; Bearer requests do not.' : null,
      spec.rate ? `Rate limited (${spec.rate}).` : null,
   ].filter(Boolean)
   return {
      tags: [spec.tag],
      summary: spec.summary,
      ...(notes.length ? { description: notes.join('\n\n') } : {}),
      operationId: `${method}${path.replace(/:([A-Za-z]+)/g, 'By-$1').split(/[^A-Za-z0-9]+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`,
      security: auth === 'public' ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(spec.body ? {
         requestBody: {
            required: spec.bodyRequired ?? true,
            content: { 'application/json': { schema: spec.body } },
         },
      } : {}),
      responses,
   }
}

// --- Routes ------------------------------------------------------------------------------

const admin = (permission) => ({ permission, rate: 'administrative mutation limit' })
const adminRead = (permission) => ({ permission })

const routes = [
   // Health
   ['get', '/health', { tag: 'Health', auth: 'public', summary: 'Liveness (no database)', response: ref('StatusResult'), errors: {} }],
   ['get', '/ready', { tag: 'Health', auth: 'public', summary: 'Readiness (database reachable)', response: ref('StatusResult'), errors: { 500: ['INTERNAL_ERROR'] } }],

   // Authentication
   ['post', '/auth/register', {
      tag: 'Auth', auth: 'public', created: true, rate: 'public auth limit',
      summary: 'Register a pending student account',
      body: body({
         phone: str({ examples: ['+992900000000'] }),
         password: str({ minLength: 12, maxLength: 128, description: 'At least one letter and one digit' }),
         firstName: str({ maxLength: 100 }),
         lastName: str({ maxLength: 100 }),
      }, ['phone', 'password', 'firstName', 'lastName']),
      response: obj({ status: str({ const: 'pending' }), user: ref('PendingUser') }),
      errors: { 409: ['PHONE_ALREADY_REGISTERED'] },
   }],
   ['post', '/auth/login/password', {
      tag: 'Auth', auth: 'public', rate: 'public auth limit + 5 attempts per phone / 15 min',
      summary: 'Log in with phone and password (sets cookies)',
      description: 'Sets `everest_access` (HttpOnly, path /), `everest_refresh` (HttpOnly, path /api/v1/auth) and the readable `everest_csrf` cookie. In Swagger UI the cookies are stored by the browser and sent automatically with later requests.',
      body: body({ phone: str({ examples: ['+992900000000'] }), password: str() }, ['phone', 'password']),
      response: ref('AuthResult'),
      headers: { 'Set-Cookie': { description: 'everest_access, everest_refresh, everest_csrf', schema: str() } },
      errors: { 401: ['INVALID_CREDENTIALS'], 403: ['ACCOUNT_NOT_ACTIVE'], 503: ['AUTH_PROTECTION_UNAVAILABLE', 'AUTH_NOT_CONFIGURED'] },
   }],
   ['post', '/auth/password-recovery/request', {
      tag: 'Auth', auth: 'public', status: 202, rate: 'public auth limit',
      summary: 'Request a recovery code (same response for every valid request)',
      body: body({ phone: str(), channel: enumOf(['telegram', 'sms']) }, ['phone', 'channel']),
      response: obj({ status: str({ const: 'accepted' }), challengeId: str() }),
   }],
   ['post', '/auth/password-recovery/verify', {
      tag: 'Auth', auth: 'public', rate: 'public auth limit',
      summary: 'Verify a recovery code',
      body: body({ challengeId: str(), code: str({ pattern: '^[0-9]{6}$' }) }, ['challengeId', 'code']),
      response: obj({ status: str({ const: 'verified' }), resetAuthorization: str(), expiresAt: dt() }),
      errors: { 401: ['INVALID_RECOVERY_CHALLENGE'] },
   }],
   ['post', '/auth/password-recovery/reset', {
      tag: 'Auth', auth: 'public', rate: 'public auth limit',
      summary: 'Set a new password and revoke every session',
      body: body({ resetAuthorization: str(), newPassword: str({ minLength: 12, maxLength: 128 }) }, ['resetAuthorization', 'newPassword']),
      response: ref('StatusResult'),
      errors: { 401: ['INVALID_RESET_AUTHORIZATION'] },
   }],
   ['post', '/auth/refresh', {
      tag: 'Auth', auth: 'public', csrf: true, rate: 'public auth limit',
      summary: 'Rotate the refresh cookie and issue a new access cookie',
      description: 'Reads only the `everest_refresh` cookie. CSRF is required when a valid refresh cookie identifies a live session.',
      response: ref('AuthResult'),
      errors: { 401: ['INVALID_REFRESH_TOKEN', 'REFRESH_TOKEN_REQUIRED', 'REFRESH_TOKEN_REUSE_DETECTED'] },
   }],
   ['post', '/auth/logout', {
      tag: 'Auth', auth: 'public', csrf: true,
      summary: 'Revoke the current session and clear cookies (safe to repeat)',
      response: ref('StatusResult'),
   }],
   ['post', '/auth/logout-all', {
      tag: 'Auth', summary: 'Revoke every session of the current user',
      response: obj({ status: str({ const: 'logged_out_all' }), revokedSessions: int() }),
   }],
   ['get', '/auth/sessions', { tag: 'Auth', summary: 'List own sessions', response: obj({ sessions: arr(ref('Session')) }) }],
   ['delete', '/auth/sessions/:sessionId', {
      tag: 'Auth', summary: 'Revoke one owned session',
      response: obj({ status: str({ const: 'revoked' }), sessionId: id(), currentSession: bool() }),
      errors: { 400: ['INVALID_SESSION_ID'], 404: ['SESSION_NOT_FOUND'] },
   }],
   ['get', '/auth/telegram/start', {
      tag: 'Auth', auth: 'public', rate: 'public auth limit',
      summary: 'Start Telegram OIDC login',
      response: obj({ authorizationUrl: str({ format: 'uri' }), expiresAt: dt() }),
      errors: { 503: ['TELEGRAM_AUTH_NOT_CONFIGURED'] },
   }],
   ['get', '/auth/telegram/callback', {
      tag: 'Auth', auth: 'public', rate: 'public auth limit',
      summary: 'Telegram OIDC callback (sets cookies when the identity is linked)',
      query: [
         { name: 'code', schema: str() },
         { name: 'state', schema: str() },
         { name: 'error', schema: str() },
      ],
      response: obj({
         status: enumOf(['authenticated', 'linking_required', 'linked']),
         expiresAt: dt(),
         user: obj({ id: id() }),
         messagingConnected: bool(),
      }),
      errors: { 400: ['VALIDATION_ERROR', 'TELEGRAM_CALLBACK_INVALID'], 401: ['TELEGRAM_STATE_INVALID', 'TELEGRAM_AUTHORIZATION_DENIED', 'TELEGRAM_CODE_EXCHANGE_FAILED', 'TELEGRAM_ID_TOKEN_INVALID'], 409: ['TELEGRAM_IDENTITY_ALREADY_LINKED', 'TELEGRAM_IDENTITY_CONFLICT'] },
   }],
   ['post', '/auth/telegram/link', {
      tag: 'Auth', summary: 'Start linking Telegram to the current account',
      response: obj({ authorizationUrl: str({ format: 'uri' }), expiresAt: dt() }),
   }],
   ['delete', '/auth/telegram/link', {
      tag: 'Auth', summary: 'Unlink Telegram (another login method must remain)',
      response: ref('StatusResult'), errors: { 409: ['LAST_LOGIN_METHOD'] },
   }],
   ['post', '/auth/telegram/test-message', {
      tag: 'Auth', summary: 'Send a Telegram test message',
      response: ref('StatusResult'),
      errors: { 409: ['TELEGRAM_CONNECTION_UNAVAILABLE'], 502: ['TELEGRAM_MESSAGE_FAILED'] },
   }],

   // Profile
   ['get', '/profile', { tag: 'Profile', summary: 'Own profile', response: ref('Profile'), errors: { 404: ['PROFILE_NOT_FOUND'] } }],
   ['patch', '/profile', { tag: 'Profile', summary: 'Update own profile', body: body(profileFields), response: ref('Profile') }],
   ['get', '/profile/onboarding', { tag: 'Profile', summary: 'Onboarding state', response: ref('Onboarding') }],
   ['patch', '/profile/onboarding', { tag: 'Profile', summary: 'Update onboarding fields', body: body(profileFields), response: ref('Onboarding') }],
   ['post', '/profile/onboarding/complete', {
      tag: 'Profile', summary: 'Complete onboarding (idempotent)', response: ref('Onboarding'),
      errors: { 409: ['ONBOARDING_INCOMPLETE'] },
   }],

   // Learner courses
   ['get', '/courses', { tag: 'Learner courses', summary: 'Enrolled published courses', response: obj({ courses: arr(ref('LearnerCourse')) }) }],
   ['get', '/courses/favorites', {
      tag: 'Learner courses', summary: 'Favorite courses',
      response: obj({ courses: arr(obj({ id: id(), title: str(), translations: ref('CourseTranslations'), coverAssetId: nullable(id()), favoritedAt: dt() })) }),
   }],
   ['put', '/courses/:courseId/favorite', {
      tag: 'Learner courses', summary: 'Add to favorites (idempotent)',
      response: obj({ courseId: id(), favorite: bool() }), errors: { 404: ['COURSE_NOT_FOUND'] },
   }],
   ['delete', '/courses/:courseId/favorite', {
      tag: 'Learner courses', summary: 'Remove from favorites (idempotent)',
      response: obj({ courseId: id(), favorite: bool() }),
   }],
   ['get', '/courses/:courseId/modules', {
      tag: 'Learner courses', summary: 'Course card and module access',
      response: obj({
         course: obj({ id: id(), title: str(), subject: nullable(ref('SubjectCard')), moduleCount: int(), lessonCount: int(), enrollment: ref('EnrollmentWindow') }),
         modules: arr(ref('LearnerModule')),
      }),
      errors: { 400: ['INVALID_COURSE_ID'], 404: ['COURSE_NOT_FOUND'] },
   }],
   ['get', '/courses/:courseId/modules/:moduleId/lessons', {
      tag: 'Learner lessons', summary: 'Lessons of a published module',
      response: obj({ lessons: arr(ref('LearnerLesson')) }),
      errors: { 404: ['COURSE_NOT_FOUND', 'COURSE_MODULE_NOT_FOUND'] },
   }],
   ['get', '/courses/:courseId/lessons/:lessonId', {
      tag: 'Learner lessons', summary: 'Lesson (full content only with module access)',
      response: obj({ lesson: ref('LearnerLesson') }), errors: { 404: ['LESSON_NOT_FOUND'] },
   }],
   ['get', '/courses/:courseId/lessons/:lessonId/playback', {
      tag: 'Learner lessons', rate: 'per-user media limit', summary: 'Signed 30-minute video URL (supports Range)',
      response: obj({ playback: ref('SignedUrl'), chapters: arr(ref('Chapter')) }),
      errors: { 403: ['MODULE_ACCESS_DENIED'], 404: ['LESSON_NOT_FOUND'], 409: ['VIDEO_NOT_PLAYABLE'] },
   }],
   ['get', '/courses/:courseId/lessons/:lessonId/resources/:resourceId/download', {
      tag: 'Learner lessons', rate: 'per-user media limit', summary: 'Signed 5-minute material URL',
      response: obj({ download: ref('SignedUrl') }),
      errors: { 403: ['MODULE_ACCESS_DENIED'], 404: ['LESSON_NOT_FOUND', 'RESOURCE_NOT_FOUND'] },
   }],
   ['post', '/courses/:courseId/lessons/:lessonId/offline-license', {
      tag: 'Offline licenses', rate: 'per-user media limit', summary: 'Create or renew the offline license for this session',
      body: body({ deviceLabel: str({ maxLength: 100 }) }), bodyRequired: false,
      response: obj({ license: ref('OfflineLicense'), download: ref('SignedUrl') }),
      errors: { 403: ['MODULE_ACCESS_DENIED', 'OFFLINE_ACCESS_DENIED'], 409: ['OFFLINE_DEVICE_LIMIT'] },
   }],
   ['get', '/courses/:courseId/lessons/:lessonId/notes', { tag: 'Learner lessons', summary: 'Own notes', response: obj({ notes: arr(ref('Note')) }) }],
   ['post', '/courses/:courseId/lessons/:lessonId/notes', {
      tag: 'Learner lessons', created: true, summary: 'Create a note',
      body: body({ body: str(), playbackSeconds: nullable(int({ minimum: 0 })) }, ['body']),
      response: obj({ note: ref('Note') }), errors: { 409: ['NOTE_LIMIT_REACHED'] },
   }],
   ['patch', '/courses/:courseId/lessons/:lessonId/notes/:noteId', {
      tag: 'Learner lessons', summary: 'Update an own note',
      body: body({ body: str(), playbackSeconds: nullable(int({ minimum: 0 })) }),
      response: obj({ note: ref('Note') }), errors: { 404: ['NOTE_NOT_FOUND'] },
   }],
   ['delete', '/courses/:courseId/lessons/:lessonId/notes/:noteId', {
      tag: 'Learner lessons', summary: 'Delete an own note', response: deleted(), errors: { 404: ['NOTE_NOT_FOUND'] },
   }],
   ['get', '/courses/:courseId/lessons/:lessonId/progress', { tag: 'Learner lessons', summary: 'Own progress', response: obj({ progress: ref('Progress') }) }],
   ['put', '/courses/:courseId/lessons/:lessonId/progress', {
      tag: 'Learner lessons', summary: 'Save progress (optimistic revision)',
      description: 'Video lessons: `{ revision, playbackSeconds, watchedSeconds }`. Other lessons: `{ revision, completed: true }`.',
      body: body({ revision: int({ minimum: 0 }), playbackSeconds: int({ minimum: 0 }), watchedSeconds: int({ minimum: 0 }), completed: bool() }, ['revision']),
      response: obj({ progress: ref('Progress') }), errors: { 409: ['PROGRESS_REVISION_CONFLICT'] },
   }],

   // Offline licenses
   ['get', '/offline-licenses', { tag: 'Offline licenses', summary: 'Active licenses of this session', response: obj({ licenses: arr(ref('OfflineLicense')) }) }],
   ['get', '/offline-licenses/:licenseId/download', {
      tag: 'Offline licenses', rate: 'per-user media limit', summary: 'New 15-minute download URL after an access check',
      response: obj({ license: ref('OfflineLicense'), download: ref('SignedUrl') }),
      errors: { 403: ['OFFLINE_ACCESS_DENIED'], 404: ['OFFLINE_LICENSE_NOT_FOUND'] },
   }],
   ['delete', '/offline-licenses/:licenseId', {
      tag: 'Offline licenses', summary: 'Revoke own license (idempotent)',
      response: obj({ license: ref('OfflineLicense') }), errors: { 404: ['OFFLINE_LICENSE_NOT_FOUND'] },
   }],

   // Groups
   ['get', '/groups', { tag: 'Groups', summary: 'Visible groups', query: limitQuery, response: page('groups', ref('Group')) }],
   ['get', '/groups/:groupId', { tag: 'Groups', summary: 'Group', response: ref('Group'), errors: { 404: ['GROUP_NOT_FOUND'] } }],
   ['get', '/groups/:groupId/members', { tag: 'Groups', summary: 'Members', query: limitQuery, response: page('members', ref('GroupMember')), errors: { 404: ['GROUP_NOT_FOUND'] } }],
   ['get', '/groups/:groupId/teachers', { tag: 'Groups', summary: 'Teachers', query: limitQuery, response: page('teachers', ref('GroupTeacher')), errors: { 404: ['GROUP_NOT_FOUND'] } }],
   ['get', '/groups/:groupId/announcements', { tag: 'Groups', summary: 'Announcements', query: limitQuery, response: page('announcements', ref('Announcement')), errors: { 404: ['GROUP_NOT_FOUND'] } }],
   ['post', '/groups/:groupId/announcements', {
      tag: 'Groups', created: true, permission: 'groups.announcements.manage', summary: 'Create an announcement',
      body: body(announcementFields, ['title', 'content']), response: ref('Announcement'), errors: { 404: ['GROUP_NOT_FOUND'] },
   }],
   ['patch', '/groups/:groupId/announcements/:announcementId', {
      tag: 'Groups', permission: 'groups.announcements.manage', summary: 'Update an announcement',
      body: body(announcementFields), response: ref('Announcement'), errors: { 404: ['GROUP_NOT_FOUND', 'ANNOUNCEMENT_NOT_FOUND'] },
   }],
   ['delete', '/groups/:groupId/announcements/:announcementId', {
      tag: 'Groups', permission: 'groups.announcements.manage', summary: 'Archive an announcement',
      response: ref('Announcement'), errors: { 404: ['GROUP_NOT_FOUND', 'ANNOUNCEMENT_NOT_FOUND'] },
   }],

   // Assets
   ['post', '/assets/uploads', {
      tag: 'Assets', created: true, rate: 'administrative mutation limit', summary: 'Start a resumable multipart upload',
      description: 'Allowed for `assets.upload` holders and assigned teachers with `canManageLessons`.',
      body: body({ courseId: id(), kind: enumOf(['video', 'material']), fileName: str(), mimeType: str(), sizeBytes: int({ minimum: 1, maximum: 21474836480 }) }, ['courseId', 'kind', 'fileName', 'mimeType', 'sizeBytes']),
      response: ref('Upload'),
      errors: { 403: ['ACTION_FORBIDDEN'], 404: ['COURSE_NOT_FOUND'], 409: ['COURSE_ARCHIVED'], 503: ['STORAGE_NOT_CONFIGURED'] },
   }],
   ['get', '/assets/uploads/:uploadId', {
      tag: 'Assets', summary: 'Upload state and parts already stored',
      response: obj({ upload: ref('Upload'), uploadedParts: arr(obj({ partNumber: int(), size: int() })) }),
      errors: { 404: ['UPLOAD_NOT_FOUND'] },
   }],
   ['post', '/assets/uploads/:uploadId/parts', {
      tag: 'Assets', summary: 'Presign part URLs (PUT the bytes directly to storage)',
      body: body({ partNumbers: arr(int({ minimum: 1 }), { minItems: 1, maxItems: 100, uniqueItems: true }) }, ['partNumbers']),
      response: obj({ parts: arr(obj({ partNumber: int(), sizeBytes: int(), url: str({ format: 'uri' }), expiresAt: dt() })) }),
      errors: { 404: ['UPLOAD_NOT_FOUND'], 409: ['UPLOAD_ABORTED', 'UPLOAD_EXPIRED'] },
   }],
   ['post', '/assets/uploads/:uploadId/complete', {
      tag: 'Assets', rate: 'administrative mutation limit', summary: 'Assemble and verify the upload (idempotent)',
      response: obj({ asset: ref('Asset') }),
      errors: { 404: ['UPLOAD_NOT_FOUND'], 409: ['UPLOAD_INCOMPLETE', 'UPLOAD_ABORTED', 'UPLOAD_REJECTED', 'UPLOAD_EXPIRED', 'UPLOAD_PARTS_MISSING'], 422: ['UNSUPPORTED_MEDIA', 'VIDEO_NOT_SEEKABLE'] },
   }],
   ['post', '/assets/uploads/:uploadId/abort', {
      tag: 'Assets', rate: 'administrative mutation limit', summary: 'Abort the upload (idempotent)',
      response: obj({ upload: ref('Upload') }), errors: { 404: ['UPLOAD_NOT_FOUND'], 409: ['UPLOAD_ALREADY_COMPLETED'] },
   }],

   // Admin: accounts
   ['get', '/admin/users/pending', {
      tag: 'Admin: accounts', ...adminRead('accounts.pending.read'), permissionError: 'ADMIN_ROLE_REQUIRED',
      summary: 'Pending accounts', query: limitQuery, response: page('users', ref('PendingUser')),
   }],
   ...['approve', 'reject', 'block', 'unblock'].map((action) => ['post', `/admin/users/:userId/${action}`, {
      tag: 'Admin: accounts', ...admin(`accounts.${action}`), permissionError: 'ADMIN_ROLE_REQUIRED',
      summary: { approve: 'pending → active', reject: 'pending → rejected', block: 'active → blocked (revokes sessions)', unblock: 'blocked → active' }[action],
      response: ref('AccountTransition'),
      errors: { 400: ['INVALID_USER_ID'], 404: ['USER_NOT_FOUND'], 409: ['INVALID_ACCOUNT_TRANSITION', 'SELF_REJECTION_FORBIDDEN', 'SELF_BLOCK_FORBIDDEN'] },
   }]),

   // Admin: courses
   ['get', '/admin/courses', { tag: 'Admin: courses', ...adminRead('courses.read'), summary: 'Visible courses', query: limitQuery, response: page('courses', ref('Course')) }],
   ['get', '/admin/courses/:courseId', { tag: 'Admin: courses', ...adminRead('courses.read'), summary: 'Course', response: ref('Course'), errors: { 404: ['COURSE_NOT_FOUND'] } }],
   ['post', '/admin/courses', { tag: 'Admin: courses', ...admin('courses.create'), created: true, summary: 'Create a draft course', body: body(courseFields, ['title']), response: ref('Course') }],
   ['patch', '/admin/courses/:courseId', { tag: 'Admin: courses', ...admin('courses.update'), summary: 'Update course metadata', body: body(courseFields), response: ref('Course'), errors: { 404: ['COURSE_NOT_FOUND'] } }],
   ['post', '/admin/courses/:courseId/publish', {
      tag: 'Admin: courses', ...admin('courses.publish'), summary: 'draft → published', response: ref('Course'),
      errors: { 404: ['COURSE_NOT_FOUND'], 409: ['INVALID_COURSE_TRANSITION', 'COURSE_NOT_READY_FOR_PUBLICATION'] },
   }],
   ['post', '/admin/courses/:courseId/unpublish', {
      tag: 'Admin: courses', ...admin('courses.publish'), summary: 'published → draft', response: ref('Course'),
      errors: { 404: ['COURSE_NOT_FOUND'], 409: ['INVALID_COURSE_TRANSITION'] },
   }],
   ['post', '/admin/courses/:courseId/copy', {
      tag: 'Admin: courses', ...admin('courses.copy'), created: true, summary: 'Copy a course as a draft',
      body: body({ title: str({ maxLength: 200 }) }), bodyRequired: false,
      response: obj({ course: ref('Course'), sourceCourseId: id(), copied: obj({ modules: int(), lessons: int(), chapters: int(), resources: int() }) }),
      errors: { 404: ['COURSE_NOT_FOUND'] },
   }],
   ['get', '/admin/courses/:courseId/preview', {
      tag: 'Admin: courses', ...adminRead('courses.read'), summary: 'Read-only structure preview',
      response: obj({ course: obj({ id: id(), title: str(), status: str() }), modules: arr(ref('PreviewModule')) }),
      errors: { 404: ['COURSE_NOT_FOUND'] },
   }],
   ['get', '/admin/courses/:courseId/teachers', { tag: 'Admin: courses', ...adminRead('courses.read'), summary: 'Assigned teachers', response: obj({ teachers: arr(ref('CourseTeacher')) }), errors: { 404: ['COURSE_NOT_FOUND'] } }],
   ['post', '/admin/courses/:courseId/teachers', {
      tag: 'Admin: courses', ...admin('courses.teachers.manage'), created: true, summary: 'Assign a teacher',
      body: body({ userId: id(), ...teacherFlags }, ['userId']), response: ref('CourseTeacher'),
      errors: { 404: ['COURSE_NOT_FOUND'], 409: ['COURSE_TEACHER_INELIGIBLE', 'COURSE_TEACHER_ALREADY_ASSIGNED'] },
   }],
   ['patch', '/admin/courses/:courseId/teachers/:userId', {
      tag: 'Admin: courses', ...admin('courses.teachers.manage'), summary: 'Update teacher flags',
      body: body(teacherFlags), response: ref('CourseTeacher'), errors: { 404: ['COURSE_NOT_FOUND', 'COURSE_TEACHER_NOT_FOUND'] },
   }],
   ['delete', '/admin/courses/:courseId/teachers/:userId', {
      tag: 'Admin: courses', ...admin('courses.teachers.manage'), summary: 'Remove a teacher',
      response: obj({ userId: id(), status: str({ const: 'removed' }) }), errors: { 404: ['COURSE_NOT_FOUND', 'COURSE_TEACHER_NOT_FOUND'] },
   }],

   // Admin: modules
   ['post', '/admin/courses/:courseId/modules', { tag: 'Admin: modules', ...admin('courses.modules.manage'), created: true, summary: 'Create a draft module', body: body(moduleFields, ['title']), response: ref('CourseModule'), errors: { 404: ['COURSE_NOT_FOUND'] } }],
   ['put', '/admin/courses/:courseId/modules/order', {
      tag: 'Admin: modules', ...admin('courses.modules.manage'), summary: 'Reorder all modules',
      body: body({ moduleIds: arr(id(), { uniqueItems: true }) }, ['moduleIds']), response: obj({ modules: arr(ref('CourseModule')) }),
      errors: { 404: ['COURSE_NOT_FOUND'], 409: ['COURSE_MODULE_ORDER_MISMATCH'] },
   }],
   ['patch', '/admin/courses/:courseId/modules/:moduleId', { tag: 'Admin: modules', ...admin('courses.modules.manage'), summary: 'Update a module', body: body(moduleFields), response: ref('CourseModule'), errors: { 404: ['COURSE_MODULE_NOT_FOUND'] } }],
   ...[['publish', 'draft → published'], ['archive', 'published → archived'], ['restore', 'archived → draft']].map(([action, summary]) => ['post', `/admin/courses/:courseId/modules/:moduleId/${action}`, {
      tag: 'Admin: modules', ...admin('courses.modules.manage'), summary, response: ref('CourseModule'),
      errors: { 404: ['COURSE_MODULE_NOT_FOUND'], 409: ['INVALID_MODULE_TRANSITION'] },
   }]),
   ['delete', '/admin/courses/:courseId/modules/:moduleId', {
      tag: 'Admin: modules', ...admin('courses.modules.manage'), summary: 'Delete an empty draft module', response: deleted(),
      errors: { 404: ['COURSE_MODULE_NOT_FOUND'], 409: ['COURSE_MODULE_NOT_DELETABLE'] },
   }],

   // Admin: enrollments
   ['get', '/admin/courses/:courseId/enrollments', {
      tag: 'Admin: enrollments', ...adminRead('courses.access.read'), summary: 'Enrollments',
      query: [...limitQuery, { name: 'state', schema: enumOf(['active', 'scheduled', 'expired', 'revoked']) }],
      response: page('enrollments', ref('Enrollment')), errors: { 404: ['COURSE_NOT_FOUND'] },
   }],
   ['post', '/admin/courses/:courseId/enrollments', {
      tag: 'Admin: enrollments', ...admin('courses.access.manage'), created: true, summary: 'Grant course access to a student',
      body: grantBody({ userId: id() }, ['userId']), response: ref('Enrollment'),
      errors: { 404: ['COURSE_NOT_FOUND', 'USER_NOT_FOUND'], 409: ['COURSE_NOT_PUBLISHED', 'ENROLLMENT_USER_INELIGIBLE', 'ENROLLMENT_ALREADY_EXISTS'] },
   }],
   ['patch', '/admin/courses/:courseId/enrollments/:userId', {
      tag: 'Admin: enrollments', ...admin('courses.access.manage'), summary: 'Change enrollment expiry',
      body: body({ expiresAt: nullable(dt()) }, ['expiresAt']), response: ref('Enrollment'),
      errors: { 404: ['ENROLLMENT_NOT_FOUND'], 409: ['ENROLLMENT_REVOKED'] },
   }],
   ['post', '/admin/courses/:courseId/enrollments/:userId/revoke', {
      tag: 'Admin: enrollments', ...admin('courses.access.manage'), summary: 'Revoke enrollment and its module grants', response: ref('Enrollment'),
      errors: { 404: ['ENROLLMENT_NOT_FOUND'], 409: ['ENROLLMENT_ALREADY_REVOKED'] },
   }],
   ['get', '/admin/courses/:courseId/enrollments/:userId/modules', {
      tag: 'Admin: enrollments', ...adminRead('courses.access.read'), summary: 'Module grants of a student', response: obj({ moduleGrants: arr(ref('ModuleGrant')) }),
   }],
   ['post', '/admin/courses/:courseId/enrollments/:userId/modules', {
      tag: 'Admin: enrollments', ...admin('courses.access.manage'), created: true, summary: 'Grant module access',
      body: grantBody({ moduleId: id() }, ['moduleId']), response: ref('ModuleGrant'),
      errors: { 404: ['ENROLLMENT_NOT_FOUND', 'COURSE_MODULE_NOT_FOUND'], 409: ['MODULE_NOT_PUBLISHED', 'ENROLLMENT_NOT_ACTIVE', 'MODULE_ACCESS_ALREADY_EXISTS'] },
   }],
   ['patch', '/admin/courses/:courseId/enrollments/:userId/modules/:moduleId', {
      tag: 'Admin: enrollments', ...admin('courses.access.manage'), summary: 'Change module grant expiry',
      body: body({ expiresAt: nullable(dt()) }, ['expiresAt']), response: ref('ModuleGrant'),
      errors: { 404: ['MODULE_ACCESS_NOT_FOUND'], 409: ['MODULE_ACCESS_REVOKED'] },
   }],
   ['post', '/admin/courses/:courseId/enrollments/:userId/modules/:moduleId/revoke', {
      tag: 'Admin: enrollments', ...admin('courses.access.manage'), summary: 'Revoke a module grant', response: ref('ModuleGrant'),
      errors: { 404: ['MODULE_ACCESS_NOT_FOUND'], 409: ['MODULE_ACCESS_ALREADY_REVOKED'] },
   }],

   // Admin: lessons
   ['get', '/admin/courses/:courseId/modules/:moduleId/lessons', { tag: 'Admin: lessons', ...adminRead('lessons.read'), summary: 'Lessons of a module', response: obj({ lessons: arr(ref('LessonSummary')) }) }],
   ['post', '/admin/courses/:courseId/modules/:moduleId/lessons', {
      tag: 'Admin: lessons', ...admin('lessons.manage'), created: true, summary: 'Create a draft lesson',
      body: body(lessonFields, ['title', 'lessonType']), response: ref('LessonDetail'),
      errors: { 404: ['COURSE_NOT_FOUND', 'COURSE_MODULE_NOT_FOUND'] },
   }],
   ['put', '/admin/courses/:courseId/modules/:moduleId/lessons/order', {
      tag: 'Admin: lessons', ...admin('lessons.manage'), summary: 'Reorder lessons',
      body: body({ lessonIds: arr(id(), { uniqueItems: true }) }, ['lessonIds']), response: obj({ lessons: arr(ref('LessonSummary')) }),
      errors: { 409: ['LESSON_ORDER_MISMATCH'] },
   }],
   ['get', '/admin/courses/:courseId/lessons/:lessonId', { tag: 'Admin: lessons', ...adminRead('lessons.read'), summary: 'Lesson detail', response: ref('LessonDetail'), errors: { 404: ['LESSON_NOT_FOUND'] } }],
   ['patch', '/admin/courses/:courseId/lessons/:lessonId', {
      tag: 'Admin: lessons', ...admin('lessons.manage'), summary: 'Edit a lesson in any status',
      body: body(lessonFields), response: ref('LessonDetail'),
      errors: { 404: ['LESSON_NOT_FOUND'], 409: ['LESSON_VIDEO_REQUIRED', 'LESSON_TYPE_NOT_PUBLISHABLE', 'CHAPTERS_EXCEED_VIDEO_DURATION'] },
   }],
   ...[['publish', 'draft → published'], ['archive', 'published → archived'], ['restore', 'archived → draft']].map(([action, summary]) => ['post', `/admin/courses/:courseId/lessons/:lessonId/${action}`, {
      tag: 'Admin: lessons', ...admin('lessons.manage'), summary, response: ref('LessonDetail'),
      errors: { 404: ['LESSON_NOT_FOUND'], 409: ['INVALID_LESSON_TRANSITION', 'LESSON_VIDEO_REQUIRED', 'LESSON_TYPE_NOT_PUBLISHABLE', 'VIDEO_NOT_PLAYABLE'] },
   }]),
   ['delete', '/admin/courses/:courseId/lessons/:lessonId', {
      tag: 'Admin: lessons', ...admin('lessons.manage'), summary: 'Delete an empty draft lesson', response: deleted(),
      errors: { 404: ['LESSON_NOT_FOUND'], 409: ['LESSON_NOT_DELETABLE'] },
   }],
   ['put', '/admin/courses/:courseId/lessons/:lessonId/chapters', {
      tag: 'Admin: lessons', ...admin('lessons.manage'), summary: 'Replace video chapters',
      body: body({ chapters: arr(body({ startSeconds: int({ minimum: 0 }), title: str({ maxLength: 200 }), translations: ref('TitleTranslations') }, ['startSeconds', 'title']), { maxItems: 100 }) }, ['chapters']),
      response: obj({ chapters: arr(ref('Chapter')) }), errors: { 409: ['LESSON_HAS_NO_VIDEO'] },
   }],
   ['put', '/admin/courses/:courseId/lessons/:lessonId/resources', {
      tag: 'Admin: lessons', ...admin('lessons.manage'), summary: 'Replace lesson materials',
      body: body({ resources: arr(body({ assetId: id(), title: str() }, ['assetId']), { maxItems: 50 }) }, ['resources']),
      response: obj({ resources: arr(ref('LessonResource')) }),
   }],
   ['get', '/admin/courses/:courseId/lessons/:lessonId/playback', {
      tag: 'Admin: lessons', ...adminRead('lessons.read'), summary: 'Staff playback preview',
      response: obj({ playback: ref('SignedUrl'), chapters: arr(ref('Chapter')) }), errors: { 409: ['VIDEO_NOT_PLAYABLE'] },
   }],
   ['get', '/admin/courses/:courseId/lessons/:lessonId/resources/:resourceId/download', {
      tag: 'Admin: lessons', ...adminRead('lessons.read'), summary: 'Staff material URL', response: obj({ download: ref('SignedUrl') }),
   }],
   ['get', '/admin/users/:userId/offline-licenses', {
      tag: 'Admin: lessons', ...adminRead('lessons.offline.manage'), summary: 'Offline licenses of a user', response: obj({ licenses: arr(ref('OfflineLicense')) }),
   }],
   ['post', '/admin/offline-licenses/:licenseId/revoke', {
      tag: 'Admin: lessons', ...admin('lessons.offline.manage'), summary: 'Revoke an offline license (idempotent)',
      response: obj({ license: ref('OfflineLicense') }), errors: { 404: ['OFFLINE_LICENSE_NOT_FOUND'] },
   }],

   // Admin: groups
   ['post', '/admin/groups', {
      tag: 'Admin: groups', ...admin('groups.create'), created: true, summary: 'Create a group',
      body: body({ code: str(), name: str(), description: nullable(str()), status: enumOf(['active', 'archived']) }, ['code', 'name']),
      response: ref('Group'), errors: { 409: ['GROUP_CODE_CONFLICT'] },
   }],
   ['patch', '/admin/groups/:groupId', {
      tag: 'Admin: groups', ...admin('groups.update'), summary: 'Update a group',
      body: body({ code: str(), name: str(), description: nullable(str()), status: enumOf(['active', 'archived']) }),
      response: ref('Group'), errors: { 404: ['GROUP_NOT_FOUND'], 409: ['GROUP_CODE_CONFLICT'] },
   }],
   ['post', '/admin/groups/:groupId/members', {
      tag: 'Admin: groups', ...admin('groups.members.manage'), created: true, summary: 'Add a student member',
      body: body({ userId: id(), isRepresentative: bool() }, ['userId']),
      response: obj({ userId: id(), status: str(), isRepresentative: bool(), joinedAt: dt() }), errors: { 404: ['GROUP_NOT_FOUND'] },
   }],
   ['delete', '/admin/groups/:groupId/members/:userId', {
      tag: 'Admin: groups', ...admin('groups.members.manage'), summary: 'Remove a member (history kept)',
      response: obj({ userId: id(), status: str(), leftAt: dt() }), errors: { 404: ['GROUP_NOT_FOUND', 'GROUP_MEMBER_NOT_FOUND'] },
   }],
   ['post', '/admin/groups/:groupId/teachers', {
      tag: 'Admin: groups', ...admin('groups.teachers.manage'), created: true, summary: 'Assign a teacher',
      body: body({ userId: id(), canPublishAnnouncements: bool(), canAssignTests: bool(), canViewResults: bool() }, ['userId']),
      response: obj({ userId: id(), assignedAt: dt(), permissions: ref('GroupTeacherPermissions') }), errors: { 404: ['GROUP_NOT_FOUND'] },
   }],
   ['delete', '/admin/groups/:groupId/teachers/:userId', {
      tag: 'Admin: groups', ...admin('groups.teachers.manage'), summary: 'Remove a teacher',
      response: obj({ userId: id(), status: str({ const: 'removed' }) }), errors: { 404: ['GROUP_NOT_FOUND', 'GROUP_TEACHER_NOT_FOUND'] },
   }],

   // Admin: taxonomy
   ['get', '/admin/subjects', { tag: 'Admin: taxonomy', ...adminRead('taxonomy.read'), summary: 'Subjects', response: obj({ subjects: arr(ref('Subject')) }) }],
   ['post', '/admin/subjects', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), created: true, summary: 'Create a subject',
      body: body(taxonomyFields({ color: enumOf(['green', 'blue', 'orange', 'purple', 'neutral'], { default: 'neutral' }) }), ['code', 'translations']),
      response: ref('Subject'), errors: { 409: ['SUBJECT_CODE_CONFLICT'] },
   }],
   ['patch', '/admin/subjects/:subjectId', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), summary: 'Update a subject',
      body: body(taxonomyFields({ color: enumOf(['green', 'blue', 'orange', 'purple', 'neutral']) })),
      response: ref('Subject'), errors: { 400: ['INVALID_SUBJECT_ID'], 404: ['SUBJECT_NOT_FOUND'], 409: ['SUBJECT_CODE_CONFLICT'] },
   }],
   ['delete', '/admin/subjects/:subjectId', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), summary: 'Delete an unused subject', response: deleted(),
      errors: { 404: ['SUBJECT_NOT_FOUND'], 409: ['SUBJECT_IN_USE'] },
   }],
   ['get', '/admin/subjects/:subjectId/sections', { tag: 'Admin: taxonomy', ...adminRead('taxonomy.read'), summary: 'Sections of a subject', response: obj({ sections: arr(ref('Section')) }), errors: { 404: ['SUBJECT_NOT_FOUND'] } }],
   ['post', '/admin/subjects/:subjectId/sections', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), created: true, summary: 'Create a section',
      body: body(taxonomyFields(), ['code', 'translations']), response: ref('Section'), errors: { 404: ['SUBJECT_NOT_FOUND'], 409: ['SECTION_CODE_CONFLICT'] },
   }],
   ['patch', '/admin/sections/:sectionId', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), summary: 'Update a section',
      body: body(taxonomyFields()), response: ref('Section'), errors: { 404: ['SECTION_NOT_FOUND'], 409: ['SECTION_CODE_CONFLICT'] },
   }],
   ['delete', '/admin/sections/:sectionId', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), summary: 'Delete an unused section', response: deleted(),
      errors: { 404: ['SECTION_NOT_FOUND'], 409: ['SECTION_IN_USE'] },
   }],
   ['get', '/admin/subjects/:subjectId/topics', { tag: 'Admin: taxonomy', ...adminRead('taxonomy.read'), summary: 'Topics of a subject (flat; build the tree from parentId)', response: obj({ topics: arr(ref('Topic')) }), errors: { 404: ['SUBJECT_NOT_FOUND'] } }],
   ['post', '/admin/subjects/:subjectId/topics', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), created: true, summary: 'Create a topic',
      body: body(taxonomyFields({ sectionId: nullable(id()), parentId: nullable(id()) }), ['code', 'translations']),
      response: ref('Topic'), errors: { 404: ['SUBJECT_NOT_FOUND'], 409: ['TOPIC_CODE_CONFLICT'], 422: ['TAXONOMY_SUBJECT_MISMATCH'] },
   }],
   ['patch', '/admin/topics/:topicId', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), summary: 'Update a topic',
      body: body(taxonomyFields({ sectionId: nullable(id()), parentId: nullable(id()) })),
      response: ref('Topic'), errors: { 404: ['TOPIC_NOT_FOUND'], 409: ['TOPIC_CODE_CONFLICT', 'TOPIC_CYCLE'], 422: ['TAXONOMY_SUBJECT_MISMATCH'] },
   }],
   ['delete', '/admin/topics/:topicId', {
      tag: 'Admin: taxonomy', ...admin('taxonomy.manage'), summary: 'Delete an unused topic', response: deleted(),
      errors: { 404: ['TOPIC_NOT_FOUND'], 409: ['TOPIC_IN_USE'] },
   }],

   // Admin: question banks
   ['get', '/admin/question-banks', {
      tag: 'Admin: questions', ...adminRead('questions.read'), summary: 'Readable banks',
      query: [...limitQuery, { name: 'subjectId', schema: id() }], response: page('banks', ref('QuestionBank')),
   }],
   ['post', '/admin/question-banks', {
      tag: 'Admin: questions', ...admin('questions.manage'), created: true, summary: 'Create a bank (caller becomes owner)',
      body: body({ code: str({ pattern: '^[a-z0-9][a-z0-9_-]{0,99}$' }), title: str({ maxLength: 200 }), subjectId: id(), visibility: enumOf(['private', 'staff']), sourceMetadata: ref('SourceMetadata') }, ['code', 'title', 'subjectId']),
      response: ref('QuestionBank'), errors: { 409: ['QUESTION_BANK_CODE_CONFLICT'] },
   }],
   ['get', '/admin/question-banks/:bankId', { tag: 'Admin: questions', ...adminRead('questions.read'), summary: 'Bank', response: ref('QuestionBank'), errors: { 404: ['QUESTION_BANK_NOT_FOUND'] } }],
   ['patch', '/admin/question-banks/:bankId', {
      tag: 'Admin: questions', ...admin('questions.manage'), summary: 'Update a bank (subject is immutable)',
      body: body({ code: str(), title: str({ maxLength: 200 }), visibility: enumOf(['private', 'staff']), sourceMetadata: ref('SourceMetadata') }),
      response: ref('QuestionBank'), errors: { 403: ['QUESTION_BANK_READ_ONLY'], 404: ['QUESTION_BANK_NOT_FOUND'], 409: ['QUESTION_BANK_CODE_CONFLICT'] },
   }],
   ['get', '/admin/question-banks/:bankId/questions', {
      tag: 'Admin: questions', ...adminRead('questions.read'), summary: 'Questions of a bank',
      query: [
         ...limitQuery,
         { name: 'status', schema: enumOf(['draft', 'published', 'archived']) },
         { name: 'questionType', schema: enumOf(['single_choice', 'multiple_choice', 'matching', 'numeric', 'short_text']) },
         { name: 'languageCode', schema: ref('LanguageCode') },
         { name: 'keyStatus', schema: enumOf(['unknown', 'proposed', 'verified']) },
         { name: 'topicId', schema: id() },
      ],
      response: page('questions', ref('QuestionSummary')), errors: { 404: ['QUESTION_BANK_NOT_FOUND'] },
   }],
   ['post', '/admin/question-banks/:bankId/questions', {
      tag: 'Admin: questions', ...admin('questions.manage'), created: true, summary: 'Create a draft question',
      body: body({ questionType: enumOf(['single_choice', 'multiple_choice', 'matching', 'numeric', 'short_text']), ...questionFields }, ['questionType', 'content']),
      response: ref('QuestionDetail'),
      errors: { 403: ['QUESTION_BANK_READ_ONLY'], 404: ['QUESTION_BANK_NOT_FOUND'], 409: ['QUESTION_EXTERNAL_ID_CONFLICT'], 422: ['TAXONOMY_SUBJECT_MISMATCH', 'QUESTION_ASSET_NOT_USABLE'] },
   }],
   ['get', '/admin/questions/:questionId', { tag: 'Admin: questions', ...adminRead('questions.read'), summary: 'Question (answer key only for bank managers)', response: ref('QuestionDetail'), errors: { 404: ['QUESTION_NOT_FOUND'] } }],
   ['patch', '/admin/questions/:questionId', {
      tag: 'Admin: questions', ...admin('questions.manage'), summary: 'Edit a draft (verified key returns to proposed)',
      body: body(questionFields), response: ref('QuestionDetail'),
      errors: { 403: ['QUESTION_BANK_READ_ONLY'], 404: ['QUESTION_NOT_FOUND'], 409: ['QUESTION_IMMUTABLE', 'QUESTION_EXTERNAL_ID_CONFLICT'], 422: ['TAXONOMY_SUBJECT_MISMATCH', 'QUESTION_ASSET_NOT_USABLE'] },
   }],
   ['delete', '/admin/questions/:questionId', {
      tag: 'Admin: questions', ...admin('questions.manage'), summary: 'Delete an unreferenced draft', response: deleted(),
      errors: { 404: ['QUESTION_NOT_FOUND'], 409: ['QUESTION_IMMUTABLE', 'QUESTION_IN_USE'] },
   }],
   ['post', '/admin/questions/:questionId/copy', {
      tag: 'Admin: questions', ...admin('questions.manage'), created: true, summary: 'Copy as a new draft (key must be re-verified)',
      response: ref('QuestionDetail'), errors: { 403: ['QUESTION_BANK_READ_ONLY'], 404: ['QUESTION_NOT_FOUND'] },
   }],
   ['put', '/admin/questions/:questionId/answer-key', {
      tag: 'Admin: questions', ...admin('questions.manage'), summary: 'Propose or clear the answer key (drafts only)',
      body: body({
         answerData: nullable(anyObject('{ optionKey } | { optionKeys } | { pairs: [{ left, right }] } | { value } | { acceptedAnswers }')),
         source: enumOf(['none', 'official_key', 'expert_review', 'ai_inference']),
         explanation: ref('RichContent'),
      }, ['answerData']),
      response: ref('QuestionDetail'), errors: { 400: ['ANSWER_KEY_INVALID'], 404: ['QUESTION_NOT_FOUND'], 409: ['QUESTION_IMMUTABLE'] },
   }],
   ['post', '/admin/questions/:questionId/answer-key/verify', {
      tag: 'Admin: questions', ...admin('questions.review'), summary: 'Verify a proposed key',
      body: body({ source: enumOf(['official_key', 'expert_review']) }, ['source']),
      response: ref('QuestionDetail'), errors: { 404: ['QUESTION_NOT_FOUND'], 409: ['QUESTION_IMMUTABLE', 'ANSWER_KEY_NOT_PROPOSED'] },
   }],
   ['post', '/admin/questions/:questionId/publish', {
      tag: 'Admin: questions', ...admin('questions.review'), summary: 'draft → published',
      response: ref('QuestionDetail'), errors: { 404: ['QUESTION_NOT_FOUND'], 409: ['INVALID_QUESTION_TRANSITION', 'QUESTION_NOT_PUBLISHABLE'] },
   }],
   ['post', '/admin/questions/:questionId/archive', {
      tag: 'Admin: questions', ...admin('questions.review'), summary: 'published → archived (one-way)',
      response: ref('QuestionDetail'), errors: { 404: ['QUESTION_NOT_FOUND'], 409: ['INVALID_QUESTION_TRANSITION'] },
   }],

   // Admin: question imports (runs are started by the CLI, read here)
   ['get', '/admin/question-imports', {
      tag: 'Admin: question imports', ...adminRead('questions.manage'), permissionError: 'ACTION_FORBIDDEN',
      summary: 'Visible import runs (administrators: all; others: own banks and own runs)',
      description: 'Also allowed with `questions.review`.',
      query: [
         ...limitQuery,
         { name: 'bankId', schema: id() },
         { name: 'status', schema: enumOf(['pending', 'validating', 'validated', 'importing', 'completed', 'failed']) },
      ],
      response: page('imports', ref('QuestionImport')),
   }],
   ['get', '/admin/question-imports/:importId', {
      tag: 'Admin: question imports', ...adminRead('questions.manage'), summary: 'One import run with counters',
      description: 'Also allowed with `questions.review`.',
      response: ref('QuestionImport'), errors: { 400: ['VALIDATION_ERROR', 'INVALID_IMPORT_ID'], 404: ['QUESTION_IMPORT_NOT_FOUND'] },
   }],
   ['get', '/admin/question-imports/:importId/errors', {
      tag: 'Admin: question imports', ...adminRead('questions.manage'), summary: 'Errors and warnings of a run',
      description: 'Also allowed with `questions.review`.',
      query: [...limitQuery, { name: 'severity', schema: enumOf(['warning', 'error']) }],
      response: page('entries', ref('QuestionImportEntry')),
      errors: { 400: ['VALIDATION_ERROR', 'INVALID_IMPORT_ID'], 404: ['QUESTION_IMPORT_NOT_FOUND'] },
   }],
]

const description = `EVEREST learning platform API. All responses use \`{ data }\` on success and \`{ error: { code, message, details } }\` on failure. Identifiers are decimal strings. Lists use \`limit\`/\`offset\` and return \`pagination: { limit, offset, hasMore }\`.

## How to sign in from this page

1. Open **Auth → POST /auth/login/password**, press *Try it out*, enter the phone and password of an **active** account and execute.
2. The browser stores the \`everest_access\`, \`everest_refresh\` and \`everest_csrf\` cookies. Every later request from this page sends them automatically (cookieAuth); you do not need the *Authorize* button.
3. For \`POST\`/\`PUT\`/\`PATCH\`/\`DELETE\` this page copies \`everest_csrf\` into the \`X-CSRF-Token\` header automatically. The browser sends \`Origin\` itself; that origin (for example \`http://localhost:4000\`) must be listed in \`CORS_ORIGINS\`, otherwise mutations return \`403 CSRF_ORIGIN_REJECTED\`.
4. Check the session with **GET /profile**. Access cookies are short-lived; call **POST /auth/refresh** when you get \`401\`, and **POST /auth/logout** to finish.

**Bearer:** clients that hold an access token can use *Authorize → bearerAuth*. Bearer requests do not need CSRF. Never paste real production tokens into shared screenshots or issues.`

function buildOpenApiDocument() {
   const paths = {}
   for (const [method, path, spec] of routes) {
      const openApiPath = path.replace(/:([A-Za-z]+)/g, '{$1}')
      paths[openApiPath] ||= {}
      paths[openApiPath][method] = operation(method, path, spec)
   }
   return {
      openapi: '3.1.0',
      info: { title: 'EVEREST API', version: '0.1.0', description },
      servers: [{ url: '/api/v1' }],
      tags: [...new Set(routes.map(([, , spec]) => spec.tag))].map((name) => ({ name })),
      paths,
      components: {
         schemas,
         securitySchemes: {
            cookieAuth: {
               type: 'apiKey',
               in: 'cookie',
               name: 'everest_access',
               description: 'HttpOnly access cookie set by password or Telegram login. Mutations also need X-CSRF-Token + Origin.',
            },
            bearerAuth: {
               type: 'http',
               scheme: 'bearer',
               bearerFormat: 'JWT',
               description: 'Access token in the Authorization header. CSRF is not required.',
            },
         },
         parameters: {
            CsrfToken: {
               name: 'X-CSRF-Token',
               in: 'header',
               required: false,
               description: 'Value of the everest_csrf cookie. Required for cookie-authenticated mutations; filled automatically by this page.',
               schema: str(),
            },
         },
      },
   }
}

// Express-style route list (method + path) for the coverage test.
const documentedRoutes = routes.map(([method, path]) => `${method.toUpperCase()} ${path}`)

export { buildOpenApiDocument, documentedRoutes }
