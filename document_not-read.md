# EVEREST Backend — инструкция для Codex и архитектура проекта

Версия: 1.0. Дата: 24 октября 2026.
В новом репозитории сохранить этот документ как `documentation.md`.

## Содержание

1. Задача Codex и источники истины
2. Что известно о стиле CRM
3. Стек и границы архитектуры
4. Структура проекта
5. Ответственность слоёв
6. Подключение через pg
7. Транзакции и конкуренция
8. Миграции node-pg-migrate
9. Окружение и запуск
10. HTTP API и обработка ошибок
11. Пользователи и авторизация
12. Группы и учебные доступы
13. Банк вопросов и импорт
14. Тестирование и оценивание
15. ИИ, бонусы, уведомления, worker
16. Тесты и проверка результата
17. Этапы разработки и первая задача
18. Открытые решения
19. Источники и навыки
20. Приложения для установки проектного навыка

## 1. Задача Codex и источники истины

Разработать backend EVEREST в привычной для Шохруха структуре CRM: JavaScript, Express, PostgreSQL, драйвер pg, миграции node-pg-migrate, разделение routes/controllers/services. Сначала изучить и зафиксировать документацию, затем выполнять конкретный запрошенный инкремент. Не реализовывать все модули одновременно.

Проект — закрытая образовательная платформа одного учебного центра: курсы, видео, модули, тесты НЦТ, группы, ИИ и бонусы. Это новый backend, а не расширение production EduCRM. Существующий CRM служит образцом организации кода, а его финансовые и multi-academy сущности не переносятся автоматически.

Источники в порядке применения:

1. Последние явные решения пользователя по EVEREST.
2. Реальный код текущего репозитория и его AGENTS.md — для фактического стиля, команд и состояния реализации.
3. `docs/db/everest_full_v0_2.sql` — проект полной схемы. Если файл приложен отдельно, сохранить его как reference, не выполнять автоматически.
4. Этот документ и журнал принятых решений.
5. Официальная документация установленных библиотек соответствующей версии.

При конфликте схемы и нового решения пользователя не править молча: описать различие, подготовить согласованное изменение миграцией. Запись «реализовано» допускается только после появления кода и проверки. Скачанный SQL не означает, что БД уже создана или подключена.

Файлы проекта различать явно:

- `documentation.md` — backend-архитектура и правила реализации;
- `AGENTS.md` — краткие постоянные инструкции агенту;
- `.agents/skills/everest-backend/SKILL.md` — навык разработки;
- `docs/db/everest_full_v0_2.sql` — reference полной БД;
- `docs/db/everest_full_v0_2.dbml` — диаграмма;
- `docs/imports/tajik-indexing.md` — отдельное задание Gemini на индексацию книги. Не перезаписывать им backend-документацию.

## 2. Что известно о стиле CRM

Пользователь передал описание структуры, но исходники CRM в этой сессии не предоставлены. Подтверждены:

- JavaScript Node.js + Express;
- PostgreSQL через pg;
- JavaScript-миграции node-pg-migrate;
- `src/app.js`, `src/server.js`;
- каталоги configs, controllers, services, routes, middleware, migrations, jobs, prompts, uploads, utils;
- kebab-case в именах `auth-service.js`, `users-controller.js`;
- отдельные repositories внутри notifications и stats;
- используемые в CRM библиотеки bcrypt/jsonwebtoken/multer/web-push/node-cron/exceljs/date-fns; интеграция Groq существует в CRM, но не выбрана автоматически для EVEREST.

Не подтверждены: CommonJS или ESM, экспорт экземпляров классов или функций, отступы/кавычки, формат ошибок, точные имена переменных окружения и сигнатура db helper. Не выдавать предположения за изучение кода.

Если доступны CRM-файлы, перед изменениями прочитать package.json, app.js/server.js, configs/db.js, configs/env.js, один route/controller/service и одну миграцию. На их основе кратко зафиксировать conventions и следовать им. Если сервисы написаны классами — сохранить классы; если функциями — функции. Не переписывать стиль ради личных предпочтений.

Для НОВОГО пустого проекта без примеров предлагается fallback: CommonJS, async/await, обычные функции, JavaScript, понятные прямые SQL-запросы в сервисах. Это новое рабочее решение, а не доказанная стилистика CRM. Примеры ниже используют CommonJS именно по этой причине.

## 3. Стек и границы архитектуры

Обязательная основа: Express, pg, PostgreSQL, node-pg-migrate. npm и package-lock.json сохраняются как в CRM. При существующем lockfile не заменять package manager и не обновлять зависимости массово.

Не вводить без запроса: TypeScript, NestJS, Prisma, Sequelize, TypeORM, Drizzle, глобальную папку modules с перестройкой всех слоёв, DI-контейнер, CQRS, микросервисы, обязательный repository для каждой сущности. Полная БД из 81 таблицы не требует 81 контроллера и 81 публичного CRUD.

Рекомендуемая архитектура — модульный монолит с привычными папками по слоям. При необходимости отдельно запускается worker, использующий ту же PostgreSQL. Redis/Kafka/Elasticsearch не являются начальным требованием.

Из текущего объёма исключены EduCRM-интеграция, встроенные видеозвонки/WebRTC, tenant_id/academy_id для SaaS, question_versions и group_courses. Не возвращать их по старой памяти о проекте.

Версии Node/Express/pg/node-pg-migrate выбрать совместимыми stable-версиями при инициализации, проверить engines и зафиксировать lockfile. Не устанавливать prerelease только потому, что открылась документация следующей версии. Если проект существует — сначала учитывать его версии. Не угадывать «последнюю LTS» по памяти.

## 4. Структура проекта

Ниже целевая организация. Файлы будущих модулей добавлять по мере реализации, а не создавать пустые заглушки сразу.

```text
everest-backend/
  package.json
  package-lock.json
  .env.example
  .gitignore
  AGENTS.md
  documentation.md
  .agents/skills/everest-backend/
    SKILL.md
    references/project-rules.md
  .github/workflows/deploy.yml
  docs/
    db/everest_full_v0_2.sql
    db/everest_full_v0_2.dbml
    imports/tajik-indexing.md
    decisions.md
    api.md
  src/
    app.js
    server.js
    configs/
      db.js
      env.js
      migrate.js
      error-handler.js
      notifications-templates.js
    controllers/
      auth-controller.js
      users-controller.js
      groups-controller.js
      courses-controller.js
      course-access-controller.js
      questions-controller.js
      tests-controller.js
      attempts-controller.js
    services/
      auth-service.js
      users-service.js
      groups-service.js
      courses-service.js
      course-access-service.js
      questions-service.js
      question-import-service.js
      tests-service.js
      attempts-service.js
      grading-service.js
      auth/providers/sms-provider.js
      auth/providers/telegram-provider.js
      ai/ai-service.js
      ai/providers/ai-provider.js
      notifications/notifications-service.js
      notifications/providers/push-provider.js
      notifications/providers/telegram-provider.js
      notifications/repositories/notifications-repository.js
      stats/stats-service.js
      stats/repositories/stats-repository.js
    routes/
      index.js
      auth.js
      users.js
      groups.js
      courses.js
      questions.js
      tests.js
    middleware/
      auth-middleware.js
      permissions-middleware.js
      validate-middleware.js
      uploads.js
    migrations/
      <timestamp>_create-auth-tables.js
      <timestamp>_create-course-access-tables.js
    jobs/
      index.js
      worker.js
      attempts-expiration-job.js
      notifications-job.js
    prompts/
      ai-assistant-prompt.md
    uploads/
      images/
    utils/
      with-transaction.js
      async-handler.js
      app-error.js
      excel/
  tests/
    integration/
    unit/
```

Это сохраняет исходное разделение CRM. Размещение error-handler.js в configs оставлено намеренно ради преемственности. Если в реальном коде другое расположение — использовать фактическое, не перемещать без необходимости.

Не добавлять ai-sql-prompt.js/sql-guard.js только потому, что они были в CRM. В EVEREST ИИ не получает произвольный SQL-доступ к БД. Файл groq-client.js не нужен до выбора Groq. Для другого провайдера использовать соответствующий адаптер, не вводить вводящее в заблуждение имя.

`src/uploads/images` допустим для локальной разработки/изображений. Видео и production-файлы хранить вне отслеживаемого исходного кода на настроенном storage; в PostgreSQL — assets с метаданными и storage_key. Не публиковать весь uploads через express.static для закрытых материалов.

## 5. Ответственность слоёв

| Слой | Делает | Не должен делать |
|---|---|---|
| routes | Объявляет URL, связывает middleware и controller | Писать SQL и рассчитывать оценки |
| middleware | Проверяет сессию, входные данные, базовые permissions | Дублировать всю бизнес-логику и доверять роли из body |
| controllers | Принимает валидированный запрос, вызывает сервис, задаёт HTTP-ответ | Управлять сложной транзакцией и обращаться к req/res из сервиса |
| services | Выполняет бизнес-правила, проверяет ресурсный доступ, транзакции, pg SQL | Зависеть от Express req/res и отправлять response |
| specialized repositories | Изолирует SQL в уже выделенных сложных notifications/stats | Стать обязательной архитектурой для любого простого сервиса |
| configs | Загружает проверенное окружение и создаёт подключения | Содержать пароль в исходнике или выполнять бизнес-процесс при import |
| jobs | Запускает фоновые процессы через те же сервисы | Реализовывать вторую отдельную бизнес-логику оценивания |

Путь запроса: route → middleware → controller → service → pg. Сервисы могут вызывать другие сервисы, передавая тот же transaction client. Не превращать простую операцию в десяток абстракций.

## 6. Подключение через pg

Создать ОДИН Pool на процесс в configs/db.js. HTTP-процесс и worker — разные процессы, каждый со своим ограниченным пулом. Размеры подбирать с учётом общего числа процессов и max_connections PostgreSQL, не задавать по большому пулу каждому PM2 worker.

В configs/env.js валидировать DATABASE_URL или согласованные DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD. Выбрать один явный способ для проекта; не хранить два противоречащих друг другу набора без правил приоритета.

Иллюстрация для нового CommonJS-проекта; структура env и logger уточняется при реализации:

```js
// src/configs/db.js
const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.dbPoolMax,
  connectionTimeoutMillis: env.dbConnectionTimeoutMs,
  idleTimeoutMillis: env.dbIdleTimeoutMs,
});

pool.on('error', (error) => {
  console.error('Unexpected idle database connection error', {
    code: error.code,
  });
});

module.exports = pool;
```

SSL настраивать по фактическому размещению/сертификатам; не отключать проверку сертификата универсальным rejectUnauthorized=false. Это пример каркаса, а не обещание готовой функции env/logger.

Для одиночного независимого запроса подходит pool.query(text, values):

```js
const pool = require('../configs/db');

async function findUserById(userId, db = pool) {
  const result = await db.query(
    'SELECT id, status, onboarding_completed_at FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

module.exports = { findUserById };
```

Не использовать SELECT * для публичного ответа. Пароль, refresh_hash, OTP, answer keys и grading snapshots не попадут в ответ только при явном безопасном DTO, а не автоматически.

SQL-значения передаются через $1/$2; имена таблиц/столбцов/ORDER BY не параметризуются таким способом. Динамические sort keys выбираются из allowlist. Не конкатенировать user input в SQL. SQL guard или промпт модели не заменяет параметризацию и permissions.

PostgreSQL NUMERIC/BIGINT может возвращаться строкой; не преобразовывать все значения в Number глобально. Сохранить точность баллов/денег/байтов, определить сериализацию API. TIMESTAMPTZ использовать для абсолютных моментов, timezone пользователя по умолчанию Asia/Dushanbe.

## 7. Транзакции и конкуренция

Все запросы транзакции выполняются через ОДИН client, полученный pool.connect. BEGIN на одном соединении и последующие pool.query на других не образуют транзакцию.

```js
// src/utils/with-transaction.js
const pool = require('../configs/db');

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Database rollback failed', { code: rollbackError.code });
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = withTransaction;
```

Сервисы внутри withTransaction принимают этот client параметром db/client; не берут новое соединение и не освобождают чужое. Транзакцией и release управляет её владелец. Не вводить вложенный BEGIN автоматически: композиция использует один client; при реально необходимой вложенной отмене — отдельно продуманные savepoints.

Для конкурентных изменений использовать FOR UPDATE/advisory lock/UNIQUE по смыслу. Блокировки брать в стабильном порядке. Node.js mutex не защищает два PM2-процесса. Транзакции держать короткими; дорогой вызов SMS/ИИ/долгая обработка видео не выполняется под блокировкой БД.

Для операции с внешним API сначала надёжно зафиксировать необходимое состояние/резерв, затем выполнить вызов, затем зафиксировать результат. При timeout статус может быть unknown; слепой retry приводит к двойному SMS/расходу. Idempotency и reconciliation обязательны там, где повтор дорогой или меняет баланс.

## 8. Миграции node-pg-migrate

Папка строго src/migrations; новые файлы — JavaScript в формате, совместимом с выбранной версией и CommonJS/ESM проекта. В существующем репозитории использовать его шаблон configs/migrate.js и команды package.json.

Для нового проекта возможен script `"migrate": "node-pg-migrate --migrations-dir src/migrations"`. Перед фиксацией проверить --help установленной stable-версии и настроить загрузку env. Команды предполагают, что DATABASE_URL уже доступен migration process; не полагаться на dotenv, который загрузился в другом процессе server.js.

```bash
npm run migrate -- create create-roles -j js
npm run migrate -- up
npm run migrate -- down
```

Последняя команда предназначена для одноразовой тестовой БД, где rollback безопасен; production rollback с удалением данных не выполнять автоматически. Если выбранная версия поддерживает dry-run, проверить его точную семантику по документации этой версии, не обещать универсальные флаги без проверки.

Пример ограниченной миграции roles в новом CommonJS-проекте, соответствующий типам полного SQL:

```js
exports.up = (pgm) => {
  pgm.createTable('roles', {
    id: { type: 'uuid', primaryKey: true },
    code: { type: 'varchar(24)', notNull: true, unique: true },
  });
  pgm.sql(`
    ALTER TABLE roles ADD CONSTRAINT roles_code_check
    CHECK (code IN ('owner', 'admin', 'teacher', 'student'));
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('roles');
};
```

Это пример механики, не инструкция повторно создавать roles, если она уже существует. Для seed использовать согласованные фиксированные UUID ролей из baseline, пользователей не создавать из произвольного SQL пользователя.

Правила:

- Не редактировать уже применённые миграции ради изменения живой схемы. Новое изменение — новый файл.
- Не подменять миграции pool.query(CREATE TABLE) в app.js/server.js.
- Полный everest_full_v0_2.sql — reference для пустой базы. Разделить его на миграции по этапам, сохранив все нужные поля, CHECK/FK/UNIQUE/индексы/функции/триггеры. Не приклеивать полный baseline после уже созданной авторизации.
- SQL-функции и триггеры включать через pgm.sql или API мигратора. Ограничения drawDB не являются причиной удалять защиту из настоящей БД; для диаграммы есть DBML.
- UUID генерирует backend; не превращать их в SERIAL. SQL названия snake_case, FK к реальным таблицам.
- Порядок миграций учитывать по зависимостям. Составные FK module/course/enrollment и attempt/test/question сохранять.
- Проверить up на чистой БД, down нужного инкремента в тестовой БД и повторный up; убедиться, что скрипт использует TEST_DATABASE_URL, а не production URL.
- Если deploy использует npm ci --omit=dev, мигратор должен быть доступен в migration stage или dependencies; не рассчитывать на отсутствующую dev dependency.
- В deploy запускать migration command один раз, затем приложение; не запускать одновременно из каждого PM2 worker. Использовать блокировки мигратора, не отключать их ради «быстрого старта».

Если БД уже существует, сначала сверить catalog и таблицу учёта мигратора. Не добавлять CREATE IF NOT EXISTS повсюду, чтобы скрыть расхождение структуры. Подготовить reconciliation migration с явным описанием.

## 9. Окружение и запуск

Создать .env.example, исключить .env, uploads, дампы и секреты из Git. Не копировать .env или deploy.yml production CRM в новый проект.

Пример названий для НОВОГО проекта, значения заполняет пользователь; это не найденные реальные CRM env:

```dotenv
NODE_ENV=development
PORT=4000
DATABASE_URL=
TEST_DATABASE_URL=
DB_POOL_MAX=5
DB_CONNECTION_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=30000
CORS_ORIGINS=http://localhost:3000
JWT_ACCESS_SECRET=
JWT_ACCESS_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
OTP_HMAC_SECRET=
SMS_PROVIDER=
SMS_API_KEY=
TELEGRAM_CLIENT_ID=
TELEGRAM_CLIENT_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_REDIRECT_URI=
STORAGE_ROOT=
AI_PROVIDER=
AI_API_KEY=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=
```

TTL/размер пула здесь — предлагаемые стартовые настройки, не окончательные решения продукта. На первом этапе валидировать только обязательные для реализованного модуля параметры. Пустой AI ключ не должен ломать старт backend, если ИИ ещё не подключён; включённая интеграция без обязательного ключа должна давать понятную configuration error.

app.js создаёт Express app, парсеры с ограничением размера, CORS по allowlist, routes и error handler. Импорт app.js не вызывает listen, миграции или запуск фоновых задач. Это позволяет тестировать HTTP без побочных эффектов.

server.js загружает окружение, проверяет необходимую готовность, запускает HTTP и обрабатывает SIGTERM/SIGINT: прекратить приём запросов, завершить сервер и pool.end в пределах grace period. Не выводить DATABASE_URL и секреты в startup logs.

Нужны health endpoint для процесса и readiness-проверка БД без утечки настроек. Миграционные версии и проверку совместимости можно добавить по фактическому deploy workflow.

## 10. HTTP API и обработка ошибок

Если существующий EVEREST frontend уже использует API contract, сохранить его. Иначе предложенный prefix — /api/v1, JSON camelCase; SQL snake_case. Явный mapping находится у границы API; не менять database column naming ради frontend.

Условный новый response contract:

```json
{"data":{"id":"example-resource-id"}}
```

```json
{"error":{"code":"MODULE_ACCESS_REQUIRED","message":"Доступ к модулю не открыт","details":[]}}
```

Называть это предложением, пока не изучен реальный контракт CRM/frontend. Pagination обязательна для больших списков; параметры limit/cursor/page валидируются. Не отдавать все 972 вопроса ученику одним запросом.

HTTP: 400 validation, 401 нет действующей сессии, 403 запрещённое действие, 404 отсутствующий/скрытый ресурс, 409 конфликт состояния, 429 лимит. Выбор 403/404 для сокрытия чужих ресурсов применять последовательно. Ошибки восстановления пароля не должны раскрывать существование номера.

Использовать один global error-handler. Для Express 4 асинхронные ошибки передавать через next или небольшой async-handler; для Express 5 проверить поддерживаемое поведение текущей версии. Не добавлять express-async-errors автоматически.

Валидация выполняется до сервиса: UUID, телефон E.164, длина строк, body allowlist, числовые границы, enum, pagination, MIME/содержимое файлов. Выбрать одну библиотеку по существующему проекту; если её нет — согласовать минимальный вариант и не смешивать несколько валидаторов.

Превратить ожидаемые PG ошибки (например UNIQUE/FK/CHECK) в стабильные domain codes. Не возвращать SQL, constraint internals, stack trace и raw provider response с секретами. JWT/OTP/пароли/ответы из закрытых ключей не писать в логи. Unexpected errors логировать безопасно с request ID.

## 11. Пользователи и авторизация

Таблицы: users, user_profiles, user_phones, user_passwords, auth_identities, roles, user_roles, auth_sessions, auth_refresh_tokens, auth_challenges, sms_deliveries, audit_events, user_invitations.

Один users.id объединяет способы входа и результаты. Telegram-only может не иметь пароля/номера на промежуточном этапе. Обязательность номера перед активацией ещё не решена. Telegram username не заменяет имя учебного профиля; изменение Telegram имени не перезаписывает профиль молча.

Телефон + пароль: нормализованный phone_e164, проверка владения через SMS-провайдера по новому требованию, хеш пароля bcrypt (либо отдельное согласованное изменение), pending после регистрации, active после approval администратора. Повышенную роль из body не принимать. Подтверждение телефона и одобрение аккаунта — разные факты.

Telegram: проверять официальным серверным протоколом, используя реальный provider subject, issuer/audience/expiry и параметры flow. Привязка требует аутентифицированного владельца и свежего подтверждения чувствительного действия. Не объединять аккаунты по имени, username или номеру из непроверенной формы. Нельзя отвязать последний способ входа.

JWT используется для короткого access token, refresh — случайный непрозрачный токен с хешем в БД. auth_refresh_tokens сохраняет историю ротации. При повторном использовании старого токена отозвать сессию. При блокировке/сбросе пароля отзыв должен действовать и для ещё не истёкшего JWT: middleware проверяет состояние user/session, а не только jwt.verify.

Для PWA выбрать cookie/Bearer transport с учётом реальных доменов frontend/backend. Cookie-вариант требует HttpOnly/Secure/SameSite и CSRF-защиты изменяющих запросов; CORS не заменяет CSRF. Не выбирать localStorage для refresh только ради простоты.

Reset: запрос номера → одноразовый challenge на уже привязанный verified phone → код + новый пароль → атомарная смена hash, consume challenge, отзыв сессий и других reset challenges, аудит. Короткий OTP защищать HMAC с серверным секретом и challenge ID либо подходящим стойким хешированием; простой SHA256 короткого кода недостаточен. Лимиты по IP/номеру/общему бюджету и cooldown обязательны. Не использовать фиксированный OTP как production fallback при отсутствии провайдера.

Набросок маршрутов, уточнить после API contract:

- POST /auth/register/request-code и /auth/register/complete;
- POST /auth/login, /auth/refresh, /auth/logout;
- GET /auth/me, GET /auth/sessions, DELETE /auth/sessions/:id;
- POST /auth/password/request-reset и /auth/password/reset;
- Telegram start/callback и authenticated link/unlink по выбранному flow;
- административное approval/block пользователя — отдельные защищённые routes.

Готовность auth нельзя объявлять только по login endpoint. Если реальный SMS/Telegram не настроен, честно отделить проверенный test adapter от недоступной живой интеграции. Интеграционные тесты могут использовать fake provider с отдельной test-конфигурацией, которая недоступна в production.

## 12. Группы и учебные доступы

Группы: groups, group_members, group_teachers, group_announcements, announcement_assets. Курс с группой не связан, group_courses отсутствует. Teacher группы не получает автоматически права на курс; это course_teachers.

Курсы: courses → course_modules → lessons; lesson_resources → assets. Доступы: course_enrollments и module_access_grants выдаются каждому человеку администратором. Обе проверки нужны для открытия модуля и его уроков. Составные FK защищают принадлежность модуля курсу и наличие назначения курса.

Admin grant service проверяет actor, разрешения, существование ученика/курса/модуля, принадлежность модуля, даты, текущую запись доступа. Для upsert и аудита использовать одну транзакцию и стабильные UNIQUE/блокировки, чтобы конкурирующие запросы не выдавали разные результаты. Нельзя незаметно создать доступ к курсу, если requested operation была только открыть модуль, без явно выбранного поведения.

Даты/отзыв проверяются в каждом запросе урока, видео, файла, course-scoped теста и offline lease. Проверка выполняется на backend; замок frontend не защищает данные. SQL can_access_module при наличии применённой функции можно использовать как helper, передавая user_id из сессии. Сессию и staff permissions он сам не проверяет.

Закрытый опубликованный модуль показывает только безопасные title/position/counts и locked=true. Уроки, тексты, ключи и постоянные ссылки на видео не выдаются. Вкладка «Материалы» также фильтруется по module access. Отсутствие grant не равно зафиксированной неоплате; payments/invoices пока не согласованы.

При revoke/expiry прогресс сохраняется. Уточнить повторное открытие курса: в текущем проекте старые ещё действующие module grants сохраняются и могут снова стать доступными после восстановления course enrollment. Если нужен полный сброс — явно revoke их в той же админской операции с аудитом.

## 13. Банк вопросов и импорт

Справочники: subjects/sections/topics и их translations. Рабочие сущности: question_banks/questions/options/matching_items/answer_keys/topics/assets/duplicate_links/imports/errors. Реальные имена сверять с SQL, не создавать альтернативные banks/options таблицы.

Правильность авторируется только в question_answer_keys; options.is_correct запрещено. content.blocks — общий контракт для текста, выделений, стихов, LaTeX/mhchem, изображений и таблиц. Язык таджикского tg. Не требовать три перевода каждого вопроса.

До публикации проверять типоспецифичный answer_data и принадлежность UUID вариантов/сторон вопросу. proposed ИИ не равен verified. Вопросы без пригодного verified key остаются draft; существующие SQL-триггеры не заменяют полного JSON validator.

Опубликованные вопросы/варианты/ключи и тесты не редактируются напрямую; создавать копию. Служебный grading_snapshot используется для истории оценивания и никогда не попадает в student DTO.

Для книги использовать docs/imports/tajik-indexing.md. Импортёр принимает ZIP/JSON пакет, выполняет безопасную распаковку, проверку manifest, реальные хеши и ссылки, dry-run и отчёт. Маппинг external IDs → UUID выполняет backend. Assets внешние ID разрешаются через asset_aliases; неизвестные ключи сохраняются SQL NULL, matching requireAllLeft/allowRightReuse не теряются и неизвестность не становится false.

Поиск существующего вопроса — bank_id + external_id. Перед вставкой проверить все ссылки, не терять записи из-за INNER JOIN. Не перезаписывать опубликованные/используемые/исправленные вручную данные через безусловный ON CONFLICT. Повторный импорт должен давать понятные counters и не создавать дубли.

## 14. Тестирование и оценивание

tests → test_questions → questions. test_assignments выбирает одну аудиторию: курс ИЛИ урок ИЛИ группа ИЛИ отдельный человек. Групповой тест не выдаёт доступ к курсам. Для нескольких аудиторий — отдельные назначения.

test_attempts → attempt_questions → student_answers. Порядок вопросов/вариантов фиксируется при старте. Ответ — одна текущая запись на вопрос попытки, autosave обновляет её с revision. Составные FK не должны теряться при конвертации baseline в миграции.

При старте попытки проверять назначение, окно, права, лимит и публикацию; сериализовать создание по assignment/user. При autosave/submit блокировать attempt, проверять status/expires_at, revision и принадлежность вариантов. После сдачи ответы не изменяются. Серверный таймер обязателен для exam/nct, job только помогает завершению; practice pause — отдельно согласованная логика.

Лимит НЦТ «одна попытка» ещё не имеет окончательно выбранной области. В схеме attempt_number считается по assignment/user; не превращать это молча в пожизненную глобальную блокировку. Частичные баллы, numeric tolerance, время показа ответов и ranking formula — отдельные решения.

Рейтинг группы вычисляется по разрешённым общим заданиям; личные практики и обменные бонусы не смешивать с рейтингом без решения пользователя. Пересчёт оценки — аудит и attempt_score_revisions, исправление бонусов — компенсация, а не повторное начисление.

## 15. ИИ, бонусы, уведомления, worker

Провайдер ИИ не выбран окончательно. Общий/курсовой чат не получает чужие данные или закрытые модули. SQL и административные инструменты не передаются модели. Бюджет и все применимые daily policies резервируются транзакционно до внешнего вызова; после ответа settle/release. Unknown outcome требует reconciliation. Пакет за бонусы не обходит денежный бюджет.

bonus_transactions и ai_usage_ledger append-only. Перед списанием блокировать счёт, проверять остаток, фиксировать source_event_key/idempotency. Обмен создаёт списание + redemption + ai_credit_grant в одной транзакции. Значения бонусов, цены пакетов и правила возврата не зашивать случайными константами.

Уведомления: in-app, Push, Telegram bot. Telegram identity для входа отдельно от telegram_connections для сообщений. notifications/deliveries различают сообщение и фактическую доставку на устройство. Проверять владельца subscription/connection; retries не гарантируют exactly-once внешнего провайдера.

jobs/index.js регистрирует обработчики, jobs/worker.js запускает worker. node-cron допустим как инициатор постановки задач, но не обеспечивает единственный запуск при нескольких процессах. PostgreSQL job queue использует SKIP LOCKED, lease, attempts и идемпотентные обработчики. Не запускать один cron при import app.js в каждом HTTP-процессе.

Экспорт exceljs и статистика читают надёжные первичные данные и соблюдают teacher resource scope. Отдельный Excel export не должен обходить ограничения доступа, действующие в обычном API.

## 16. Тесты и проверка результата

Если в репозитории уже есть test runner/linter — использовать его. Для пустого проекта возможны node:test + HTTP test client; не добавлять Jest/Vitest/TypeScript toolchain без причины. ESLint/formatter настраивать под фактический стиль, не форматировать весь CRM заодно.

Обязательны содержательные проверки по реализуемому этапу:

- миграции применяются на чистой тестовой PostgreSQL и повторяются после безопасного rollback;
- UNIQUE телефона/identity и конкурентная регистрация не создают два аккаунта;
- pending/blocked, отозванная session, чужой UUID и самоназначение роли запрещены;
- OTP одноразовый, имеет TTL/лимиты; reset отзывает сессии;
- module другого course не получает grant, без course access урок недоступен, revoke/expiry закрывают файл;
- опубликованные вопросы/тесты не меняются; ключи не попадают в student API;
- autosave после submit запрещён; два одновременных start/submit не удваивают результат;
- награда/расход ИИ/списание бонусов не повторяются от retry;
- в логах и ответах нет секретов и чужих данных.

Не имитировать интеграционный pg-тест полностью замоканными query(), если проверяется реальная транзакция/блокировка/FK. Использовать disposable test DB. Для внешних провайдеров test doubles уместны, но они не подтверждают реальную доставку SMS/Telegram.

Отчёт Codex: что изменено, реальные команды/результаты проверки, что не запускалось и почему. Не писать «все тесты пройдены», если runner отсутствует или выполнялась только проверка синтаксиса.

## 17. Этапы разработки и первая задача Codex

Работать небольшими законченными инкрементами:

1. Документация, conventions, минимальный Express/pg каркас, env/error handling/health, миграционная конфигурация.
2. Пользователи/роли/профиль/телефон/пароль, SMS registration/reset, approval, сессии, Telegram и аудит — по согласованным интеграциям.
3. Assets, курсы, модули, уроки, индивидуальные course/module grants и закрытая выдача файлов.
4. Группы, участники, преподаватели, объявления.
5. Банк, ключи и dry-run импорт.
6. Назначения тестов, попытки, timer/autosave/grade и результаты.
7. Worker/уведомления, ИИ с бюджетом, бонусы/достижения, аналитика/экспорт, offline.

Первая задача после получения этого документа:

«Изучи AGENTS.md, этот документ, reference SQL и доступные примеры CRM. Создай/обнови root documentation.md, не затирая чужие правки; установи проектный everest-backend из приложения. Зафиксируй подтверждённый стиль и явно предложенные fallback-решения. Подготовь поэтапный план и приступай только к первому инкременту: JavaScript/Express/pg каркас, env, global error handler, health/readiness и node-pg-migrate configuration. Не создавай сразу все 81 таблицу и CRUD будущих модулей. Не подключай оплачиваемые внешние провайдеры и не меняй production».

Если пользователь просит только документацию, завершить документацией. Если просит начать backend — выполнить оговорённый инкремент и проверить его; не останавливаться на одном плане. При наличии кодовой базы минимально дополнять её вместо переинициализации.

В docs/decisions.md вести: дата, принятое решение, основание, заменённое правило. В docs/api.md описывать реализованные endpoints; планы явно маркировать. После каждого инкремента обновлять документацию так, чтобы следующий чат видел реальное состояние проекта.

## 18. Открытые решения

Не задавать весь список одновременно. Сначала только то, что блокирует следующий endpoint/миграцию:

- Telegram-only: обязательность номера до активации, точные требования к имени/фамилии;
- официальный SMS-провайдер с доставкой +992, TTL/cooldown/лимиты и процедура смены номера;
- transport токенов и домены frontend/backend;
- границы полномочий owner/admin/teacher;
- сроки course/module access и восстановление старых grants;
- НЦТ: область одной попытки, reveal timing, частичные баллы и numeric normalization;
- ranking formula и период;
- ИИ: модель/бюджет, общий пул группы или личные нормы, взаимодействие пакетов и daily limits;
- completion threshold и offline lease/conflict rules.

Не спрашивать заново, нужны ли group_courses/EduCRM/видеозвонки: они уже исключены. Не считать предыдущую рекомендацию подтверждённой пользователем.

## 19. Источники и навыки

Официальные источники проверены 24.10.2026:

- Anthropic skills: https://github.com/anthropics/skills
- Anthropic skill-creator: https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
- Anthropic webapp-testing: https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md
- Codex skill discovery: https://learn.chatgpt.com/docs/build-skills
- Постоянные инструкции проекта: https://learn.chatgpt.com/docs/customization/overview
- pg queries: https://node-postgres.com/features/queries
- pg transactions: https://node-postgres.com/features/transactions
- node-pg-migrate: https://salsita.github.io/node-pg-migrate/getting-started

Среди проверенных официальных Anthropic примеров подходящего backend-style навыка Express/pg не найдено. skill-creator помогает создавать навыки, webapp-testing проверяет браузерный UI через Playwright. Они не задают архитектуру нашего backend.

everest-backend — собственный навык для этого проекта, не «официальный backend skill Anthropic». Он использует совместимый формат SKILL.md. AGENTS.md содержит обязательные постоянные conventions, навык — специализированный рабочий процесс.

Для Codex CLI/IDE проектные навыки размещаются в `.agents/skills/<name>/SKILL.md`. Сам факт создания навыка в ChatGPT Work не устанавливает файл на ноутбук пользователя. Для VS Code создать проектную папку из приложения ниже. Если навык не появился в списке, проверить его имя/формат и перезапустить Codex согласно актуальной документации.

## 20. Приложения для установки проектного навыка

Далее приведены точные содержимые двух файлов. Codex должен создать их в `.agents/skills/everest-backend/`, сохранив относительную ссылку на references/project-rules.md. Не класть одиночный произвольный skill.md в src и не менять skill name.

### .agents/skills/everest-backend/SKILL.md

````markdown
---
name: everest-backend
description: Develop and review EVEREST backend in Shohrukh’s CRM style using JavaScript, Express, pg and node-pg-migrate. Use for EVEREST routes, controllers, services, SQL transactions, migrations, access control, authentication, question imports, tests, jobs and API documentation. Preserve the existing layer-based src structure; do not migrate to TypeScript, an ORM or feature folders without the user’s request.
---

# EVEREST Backend

## Establish context

Read repository AGENTS.md, documentation.md, package.json, lockfile and relevant migrations. For project invariants and defaults, read [project-rules.md](references/project-rules.md). When working on external integrations or migration tooling, consult the installed version and current official documentation.

Inspect representative route, controller, service, configs/db.js and one migration before changing code. If only a prose CRM description is available, distinguish observed structure from unknown syntax. Follow actual code for CommonJS/ESM, named exports, indentation, quotes, function/class style and response shape. For an empty repository, use the documented JavaScript/CommonJS fallback and record it as a new choice, not an inferred fact about CRM.

## Preserve structure

Keep src/app.js and src/server.js; configs/, routes/, controllers/, services/, middleware/, migrations/, jobs/, prompts/, uploads/, utils/. Keep kebab-case filenames such as course-access-service.js and users-controller.js. Use snake_case SQL identifiers. Add only files needed for the current increment, not placeholder files for every future entity.

Keep business logic in services, HTTP parsing/status/response in controllers, routing and middleware wiring in routes. Direct parameterized pg queries in services are valid. Preserve specialized notifications/stats repositories when present; do not impose a global repository/DTO/DI framework. Keep existing function or class organization instead of inventing a replacement.

## Implement one increment

1. Read current requirements and schema for the affected module. Identify unresolved choices that change this increment; reuse explicit user decisions rather than asking again.
2. Define input validation, actor permission, resource scope, state transitions and expected response.
3. Write new node-pg-migrate JavaScript migrations for schema changes. Preserve applied migrations and existing data. Treat full SQL as a baseline/reference, not an incremental script to rerun.
4. Implement route → controller → service → pg, with explicit safe response fields.
5. Use one acquired Pool client for BEGIN, every statement, COMMIT/ROLLBACK and finally release. Pass that client into participating services; do not start transaction queries through pool.query.
6. Serialize competing mutations with row/advisory locks or constraints. Apply idempotency to attempts, grading, rewards, budget reserves and provider retries.
7. Run relevant validation and integration checks against a disposable test database. Report actual results and blockers accurately.
8. Update project documentation and decision notes to describe implemented behavior, not aspirational endpoints.

## Enforce data and access rules

Use one users.id for phone/password/Telegram identity and learning history. Verify Telegram through its official protocol. Reset passwords only through an already linked verified phone or another separately authorized recovery flow. Keep raw passwords, OTPs, refresh tokens and provider keys out of logs and database metadata.

Treat active account, live session, role permission and resource grant as separate checks. Do not rely on an unexpired JWT alone after session revocation. Never trust a client-supplied user_id as the authenticated actor.

Keep groups independent from courses: no group_courses, no automatic access from membership. Only an authorized administrator grants course_enrollments and separate module_access_grants. Check both grants and their dates/revocation for lessons, files, course-scoped tests and offline permissions. Expose only safe metadata for locked modules.

Keep published question/test content immutable. Author correctness only in question_answer_keys; options have no is_correct. Keep all unreviewed book imports draft and unknown answers unknown. Treat grading_snapshot as private historical evidence, not a second editable key. Never serialize it in student responses.

Lock and validate attempts before autosave, submit, expiry and grading; reject edits after finalization. Use revision for concurrent autosave. Do not silently choose NCT attempt scope, partial credit, reveal timing or ranking formula when the user has not decided them.

Keep bonus and AI usage journals append-only. Reserve AI budget before a paid call; reconcile unknown outcomes before refund/retry. Exchange packages do not override the center’s cash budget.

## Check implementation details

Parameterize SQL values with $1/$2. Allowlist dynamic identifiers and ORDER BY fields; parameters cannot safely substitute identifiers. Do not send arbitrary SQL from an AI model to the database.

Validate IDs, bodies, pagination and file contents. Map database errors to stable API errors without SQL text, stack traces or private data. Preserve NUMERIC/BIGINT precision; do not blindly convert all numeric strings to Number.

Keep migrations out of per-request startup. Importing app.js must not listen, run jobs or mutate schema. Start workers explicitly, and use PostgreSQL leases/locks for multi-process safety. Do not assume a cron runs once under PM2 cluster.

Do not introduce Groq, SMS, video hosting, Redis or another paid provider solely because it existed in CRM. Add provider adapters only when required by the current task. Do not reintroduce EduCRM integration, videoconferencing, multitenancy or question_versions.

## Completion report

State what changed, the relevant files, how it was verified, actual test results and unresolved decisions. Separate planned work from implemented behavior. Keep changes scoped to the user’s requested increment.

This is a custom EVEREST skill. It is not an official Anthropic backend skill. Its format follows the Agent Skills convention; the engineering rules come from the user’s CRM description and EVEREST decisions.

````

### .agents/skills/everest-backend/references/project-rules.md

````markdown
# Project rules and evidence

## Contents

- Confirmed structure and unknown syntax
- EVEREST domain invariants
- Database and migration workflow
- Integration and test boundaries

## Confirmed structure and unknown syntax

The user supplied a prose description of CRM backend, not its source repository. It identifies JavaScript, Express, PostgreSQL, pg, node-pg-migrate, bcrypt, jsonwebtoken, multer, node-cron, web-push, exceljs and date-fns. CRM has layer-based configs/controllers/services/routes/middleware/migrations/jobs/prompts/uploads/utils, app.js and server.js. notifications and stats have specialized repositories. Preserve that organization for EVEREST.

The description does not establish CommonJS versus ESM, function versus class services, named export conventions, exact middleware signatures, indentation, quote style, error envelope or DB environment variable names. Inspect actual code when available. If initializing a new project without examples, use JavaScript/CommonJS, async/await, kebab-case filenames and direct SQL services as explicit provisional defaults. Do not call these defaults verified CRM style.

Keep error-handler.js in configs if preserving the supplied layout. Do not move folders just to match a preferred convention. Add .env.example with empty secret placeholders; do not copy production .env, database dumps or old deployment credentials.

## EVEREST domain invariants

- One center; roles owner/admin/teacher/student. Account active, session valid, authorized action and resource access must all hold.
- Telephone/password and Telegram bind to the same users.id. No account merging by name, username or unverified phone.
- groups, group_members, group_teachers, group_announcements and announcement_assets are needed. group_courses is explicitly excluded.
- courses → course_modules → lessons. An administrator individually grants course_enrollments and module_access_grants. Granting a course does not open all modules. Membership in a group grants neither.
- Locked modules expose only published safe metadata. Preserve progress after expiry/revocation.
- In the v0.2 reference, course_enrollments is unique on (user_id,course_id), module_access_grants on (user_id,module_id), and course_modules has UNIQUE(id,course_id). Grants also require id, granted_by and dates/optional revocation fields. Do not substitute a different ON CONFLICT target or omit required columns when writing executable inserts. Read the actual table definition; if only a minimal illustrative schema is supplied, keep pseudocode separate from migration-ready code.
- Questions use content.blocks, options, matching items and question_answer_keys. No question_versions and no options.is_correct. Published content changes through a copy.
- Prior documentation reports 972 Tajik-book questions with no verified keys; do not claim independent PDF verification or publish them automatically.
- The book indexing instruction and the backend documentation are different documents. Keep indexing under docs/imports/ and backend documentation at the project root.
- Exclude EduCRM, integrated video calls and automatic payment integrations unless explicitly requested later.
- Groups’ ranking, NCT attempt scope, SMS vendor, Telegram-only mandatory phone, expiry defaults, partial scoring and AI package interactions remain configurable/open. An earlier proposal is not user confirmation.

## Database and migration workflow

Read docs/db/everest_full_v0_2.sql if supplied. It is a proposed complete baseline of 81 tables, not proof that a DB/server/API is deployed. Write incremental JavaScript node-pg-migrate migrations in src/migrations. Use UUID keys, TIMESTAMPTZ, NUMERIC/integer money units, parameterized queries, FK/UNIQUE/CHECK and appropriate indexes.

For a new DB, apply only migrations needed by the current increment. For an existing DB, inspect applied migrations/catalog and reconcile changes; never run the full baseline on top of existing auth tables. Preserve composite FKs tying module/course/enrollment and test/assignment/question/attempt.

Use pgm.sql for functions/triggers or constraints where the chosen migration API is inconvenient. Full PostgreSQL functions may not import into diagram tools. Use DBML or a separately generated schema-only file for diagrams; do not delete DB protections to make a diagram importer happy.

Test migration up, rollback where safe, and reapplication in disposable DBs. Do not pretend destructive down migrations preserve learning history. Run deploy migrations once with the migration tool’s locking mechanism, not from every PM2 worker.

## Integration and test boundaries

Importing app.js constructs the Express app only. server.js starts HTTP and graceful shutdown. jobs/index.js registers processors; an explicit worker entry starts them when needed. Scheduled work across processes needs locks/leases.

Keep SQL in services unless the existing module already has a repository. A participating function accepts a transaction client when it is part of a larger atomic operation. Only the transaction owner releases the acquired client.

Useful tests exercise forbidden access, duplicate identities/phones, revocation, concurrent attempts/autosave, single-use OTP, grant mismatch, immutable published questions, idempotent ledger entries and exact accounting. Prefer existing tools; for a fresh project node:test and an HTTP test client are reasonable choices. External providers use test doubles until configured, and test mode must never become an auth bypass in production.

Official references checked 24 October 2026:

- https://node-postgres.com/features/queries
- https://node-postgres.com/features/transactions
- https://salsita.github.io/node-pg-migrate/getting-started
- https://github.com/anthropics/skills
- https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md
- https://raw.githubusercontent.com/anthropics/skills/main/skills/webapp-testing/SKILL.md
- https://learn.chatgpt.com/docs/build-skills

Anthropic skill-creator is a skill authoring reference; webapp-testing concerns Playwright browser checks. Neither is a JavaScript/Express/pg architecture standard. Do not attribute this custom skill to Anthropic.

````
