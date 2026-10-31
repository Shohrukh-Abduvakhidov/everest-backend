# Question import contract (input for M09)

Status: reference document, written 2026-10-30, **updated 2026-10-31 for M09**.

- §1–§8 describe the schema and the M08 rules that the importer is bound by. Where M09 changed a statement, it is marked *(M09)*.
- §9 is the **implemented** package format `everest.question-import.v1`.
- §10 lists which §8 gaps M09 closed and which remain.

The pipeline is implemented in M09: `scripts/import-question-package.js` → `src/services/question-import-service.js` → repositories. Operating instructions are in `docs/import-runbook.md`.

The original sources of §1–§8 are `src/migrations/*`, `src/repositories/{taxonomy,question-bank}-repository.js`, `src/services/{taxonomy,question-bank,asset-upload}-service.js`, `src/utils/question-content.js`, `docs/api.md` and `docs/decisions.md`.

Two kinds of limit appear below:

- **DB** limits are enforced by PostgreSQL.
- **API** limits are enforced by the M08 services. An importer that writes through those services (the intended path) is bound by both.

---

## 1. Tables

### 1.1 Taxonomy

**`subjects`**

| Column | Type | Null | Default | Constraints (DB) | API rules |
|---|---|---|---|---|---|
| `id` | BIGINT identity | no | — | PK | — |
| `code` | TEXT | no | — | UNIQUE (global) | `^[a-z0-9][a-z0-9_-]{0,49}$` |
| `primary_language` | VARCHAR(2) | no | `'tg'` | CHECK `tg\|ru\|en` | same |
| `color` | VARCHAR(16) | no | `'neutral'` | CHECK `green\|blue\|orange\|purple\|neutral` | same |

**`subject_translations`**, **`section_translations`** and **`topic_translations`** share one shape:

| Column | Type | Null | Constraints (DB) | API rules |
|---|---|---|---|---|
| `<entity>_id` | BIGINT | no | FK → entity, RESTRICT | — |
| `language_code` | VARCHAR(2) | no | CHECK `tg\|ru\|en` | — |
| `title` | TEXT | no | — | trimmed, 1–200 characters |
| PK | | | (`<entity>_id`, `language_code`) | the primary-language row is **mandatory** |

The entities have no title column; the display title is the translation in `primary_language`. Translations carry `title` only (no description). `PATCH` replaces the whole translation set.

**`sections`**

| Column | Type | Null | Default | Constraints (DB) |
|---|---|---|---|---|
| `id` | BIGINT identity | no | — | PK; UNIQUE (`id`, `subject_id`) |
| `subject_id` | BIGINT | no | — | FK → subjects |
| `code` | TEXT | no | — | UNIQUE (`subject_id`, `code`); API regex as for subjects |
| `primary_language` | VARCHAR(2) | no | `'tg'` | CHECK `tg\|ru\|en` |

**`topics`** (hierarchy)

| Column | Type | Null | Default | Constraints (DB) |
|---|---|---|---|---|
| `id` | BIGINT identity | no | — | PK; UNIQUE (`id`, `subject_id`) |
| `subject_id` | BIGINT | no | — | FK → subjects |
| `section_id` | BIGINT | yes | NULL | FK (`section_id`, `subject_id`) → sections: the section must be in the same subject |
| `parent_id` | BIGINT | yes | NULL | FK (`parent_id`, `subject_id`) → topics: same subject; CHECK `parent_id <> id` |
| `code` | TEXT | no | — | UNIQUE (`subject_id`, `code`) |
| `primary_language` | VARCHAR(2) | no | `'tg'` | CHECK |

API rules for topics:

- A cycle returns `409 TOPIC_CYCLE`. It is checked in a transaction after locking the subject's topic rows.
- A section or parent from another subject returns `422 TAXONOMY_SUBJECT_MISMATCH`.
- A parent must exist before its child, so the import order is parent first.

### 1.2 Banks and questions

**`question_banks`**

| Column | Type | Null | Default | Constraints (DB) | API rules |
|---|---|---|---|---|---|
| `id` | BIGINT identity | no | — | PK; UNIQUE (`id`, `subject_id`) | — |
| `code` | TEXT | no | — | UNIQUE (global) | `^[a-z0-9][a-z0-9_-]{0,99}$` |
| `title` | TEXT | no | — | — | trimmed, 1–200 |
| `subject_id` | BIGINT | no | — | FK → subjects | immutable after creation |
| `owner_id` | BIGINT | no | — | FK → users | the creating user |
| `visibility` | VARCHAR(16) | no | `'private'` | CHECK `private\|staff` | same |
| `source_metadata` | JSONB | no | `'{}'` | — | allowlist, see §1.4 |
| `created_at` | TIMESTAMPTZ | no | now | — | — |

**`questions`**

| Column | Type | Null | Default | Constraints (DB) | API rules |
|---|---|---|---|---|---|
| `id` | BIGINT identity | no | — | PK; UNIQUE (`id`, `subject_id`) | — |
| `bank_id`, `subject_id` | BIGINT | no | — | FK (`bank_id`, `subject_id`) → question_banks | `subject_id` is copied from the bank |
| `external_id` | TEXT | **yes** | NULL | UNIQUE (`bank_id`, `external_id`); several NULLs allowed | trimmed, 1–200 |
| `question_type` | VARCHAR(24) | no | — | CHECK `single_choice\|multiple_choice\|matching\|numeric\|short_text` | immutable after creation |
| `language_code` | VARCHAR(2) | no | — | CHECK `tg\|ru\|en` | default `tg` |
| `difficulty` | SMALLINT | yes | — | CHECK 1–5; CHECK (`difficulty` IS NULL) = (`difficulty_source` IS NULL) | both or neither |
| `difficulty_source` | VARCHAR(16) | yes | — | CHECK `ai\|expert\|official` | — |
| `status` | VARCHAR(16) | no | `'draft'` | CHECK `draft\|published\|archived` | see §5 |
| `content` | JSONB | no | `{"blocks":[]}` | CHECK object | rich content, ≥1 block |
| `interaction_settings` | JSONB | no | `'{}'` | CHECK object | see §3 |
| `source_metadata` | JSONB | no | `'{}'` | — | allowlist, see §1.4 |
| `source_question_id` | BIGINT | yes | — | FK → questions; CHECK ≠ `id` | set only by copy |
| `import_id` | BIGINT | yes | — | FK → question_imports | *(M09)* set by the importer to the run that last created or updated the draft |
| `created_by` | BIGINT | no | — | FK → users | — |
| `created_at`, `updated_at` | TIMESTAMPTZ | no | now | — | — |

**`question_options`** and **`question_matching_items`**

| Column | Type | Null | Constraints (DB) | API rules |
|---|---|---|---|---|
| `id` | BIGINT identity | no | PK; UNIQUE (`id`, `question_id`) | not exposed |
| `question_id` | BIGINT | no | FK → questions | — |
| `side` (matching only) | VARCHAR(5) | no | CHECK `left\|right` | — |
| `option_key` / `item_key` | TEXT | no | UNIQUE (`question_id`, key), plus `side` for matching | `^[A-Za-z0-9_-]{1,20}$`, unique per list |
| `position` | INTEGER | no | CHECK > 0; UNIQUE (`question_id`, position), plus `side` for matching | the array order (1..n) |
| `source_label` | TEXT | yes | — | ≤50 characters, e.g. `"А)"` |
| `content` | JSONB | no | default `{"blocks":[]}` | rich content, ≥1 block |

- Options: 2–10 items. Matching: 1–20 per side.
- Options have **no `is_correct`**. Correctness lives only in `question_answer_keys`.
- Write semantics: options and matching items are replaced as a whole list on every write.

**`question_answer_keys`** (one row per question)

| Column | Type | Null | Default | Constraints (DB) |
|---|---|---|---|---|
| `question_id` | BIGINT | no | — | PK, FK → questions |
| `status` | VARCHAR(16) | no | `'unknown'` | CHECK `unknown\|proposed\|verified` |
| `source` | VARCHAR(24) | no | `'none'` | CHECK `none\|official_key\|expert_review\|ai_inference` |
| `answer_data` | JSONB | yes | — | CHECK object or NULL; CHECK `status = 'unknown'` OR `answer_data` NOT NULL |
| `explanation` | JSONB | no | `{"blocks":[]}` | rich content, may be empty |
| `verified_by` | BIGINT | yes | — | FK → users |
| `verified_at` | TIMESTAMPTZ | yes | — | — |
| `updated_at` | TIMESTAMPTZ | no | now | — |

Additional CHECKs:

- `status <> 'verified'` OR (`verified_by`, `verified_at` NOT NULL AND `source <> 'none'`).
- `question_answer_keys_verified_source_check` (M08): `status <> 'verified'` OR `source IN ('official_key','expert_review')`.

**`question_topics`**

- Columns: `question_id`, `topic_id`, `subject_id` (all BIGINT NOT NULL).
- PK (`question_id`, `topic_id`).
- FK (`question_id`, `subject_id`) → questions and FK (`topic_id`, `subject_id`) → topics, so a topic must be in the question's subject.
- API: at most 20 distinct topics.

**`question_assets`**

- Columns: `question_id`, `asset_id`; PK on both.
- The API recomputes this table from every image block in the question, options, matching items and explanation. It is never written directly.

**`question_duplicate_links`**

- Columns: `question_id`, `duplicate_of_id` (FK → questions), `reason` TEXT NULL, `marked_by` BIGINT NOT NULL (FK → users).
- PK (`question_id`, `duplicate_of_id`); CHECK `question_id <> duplicate_of_id`.
- **No API.** *(M09)* The importer writes conservative duplicate suggestions here. An M08 draft referenced here cannot be deleted (`409 QUESTION_IN_USE`).

**Import bookkeeping** *(M09: implemented; index `question_import_errors (import_id, id)` added)*:

- `question_imports`:
   - `bank_id` NOT NULL, `initiated_by` NOT NULL;
   - `package_sha256` VARCHAR(64) NOT NULL, `schema_version` TEXT NOT NULL, `idempotency_key` TEXT NOT NULL;
   - `is_dry_run` default TRUE;
   - `status` CHECK `pending\|validating\|validated\|importing\|completed\|failed`;
   - `manifest` JSONB NOT NULL, `counters` JSONB default `{}`, `created_at`, `finished_at`;
   - UNIQUE (`bank_id`, `idempotency_key`).
- `question_import_errors`: `import_id`, `external_id`, `record_path`, `severity` CHECK `warning\|error`, `error_code`, `message`, `created_at`.

All question child tables have guard triggers: inserts, updates and deletes are allowed only while the parent question is `draft` (`QUESTION_IMMUTABLE` otherwise).

### 1.3 Assets

**`assets`**

| Column | Type | Null | Default | Constraints (DB) |
|---|---|---|---|---|
| `id` | BIGINT identity | no | — | PK |
| `storage_key` | TEXT | no | — | UNIQUE; never returned by the API |
| `mime_type` | TEXT | no | — | — |
| `file_name` | TEXT | yes | — | — |
| `size_bytes` | BIGINT | no | — | CHECK ≥ 0 |
| `sha256` | VARCHAR(64) | yes | — | CHECK hex64; *(M09)* partial UNIQUE index `assets_sha256_key`; filled by the importer, still not by the M07-A upload flow |
| `width_px`, `height_px` | INTEGER | yes | — | CHECK > 0; filled from the PNG header (and video metadata) |
| `duration_seconds` | INTEGER | yes | — | video only |
| `status` | VARCHAR(16) | no | `'pending'` | CHECK `pending\|ready\|quarantined\|archived` |
| `uploaded_by` | BIGINT | yes | — | FK → users |
| `source_metadata` | JSONB | no | `'{}'` | — |
| `kind` | VARCHAR(16) | no | `'material'` | CHECK `video\|material` |
| `processing_status` | VARCHAR(16) | no | `'none'` | CHECK `none\|not_required\|pending\|processing\|completed\|failed` |
| `processing_error` | TEXT | yes | — | — |
| `created_at` | TIMESTAMPTZ | no | now | — |

**`asset_aliases`** *(M09: used by the importer)*:

- Columns: `source_namespace` TEXT, `external_id` TEXT, `asset_id` FK.
- UNIQUE (`source_namespace`, `external_id`). It is designed for mapping package-local file IDs to assets.

**`asset_uploads`** links each upload to `course_id` (NOT NULL). Assets themselves have no course column.

### 1.4 `source_metadata` (banks and questions)

Allowed keys only; any other key returns `400 VALIDATION_ERROR`.

| Key | Type |
|---|---|
| `book` | string, 1–500, trimmed |
| `edition` | string, 1–500 |
| `page` | integer ≥ 1 |
| `number` | string, 1–500 (e.g. `"12а"`) |
| `note` | string, 1–500 |
| `chapter`, `variant` *(M09)* | string, 1–500 |
| `year` *(M09)* | integer 1900–2100 |

---

## 2. Rich content

The same contract is used by question `content`, option and matching-item `content`, and answer-key `explanation`:

```json
{ "blocks": [ { "type": "..." } ] }
```

Limits:

- 1–100 blocks. The explanation may be empty: `{ "blocks": [] }`.
- At most 65,536 bytes of serialized JSON per content value.
- Each block is rebuilt from an allowlist. Unknown properties, unknown block types, HTML fields or extra top-level keys return `400 VALIDATION_ERROR`.

| `type` | Fields | Rules |
|---|---|---|
| `text` | `text`, optional `marks` | `text`: non-blank string ≤10,000 characters. `marks`: distinct values from `bold`, `italic`, `underline`, `subscript`, `superscript`, applied to the **whole block** (there is no inline span markup) |
| `verse` | `lines` | 1–100 strings, each ≤1,000 characters; empty lines allowed |
| `formula` | `latex`, optional `display` | `latex`: non-blank ≤2,000 characters; `display`: boolean (block vs inline intent; rendering is a frontend concern) |
| `chemistry` | `formula` | non-blank ≤2,000 characters (e.g. mhchem `\ce{}` text; not interpreted by the backend) |
| `table` | `rows` | 1–50 rows, each 1–20 string cells, each ≤1,000 characters; no header flag, no merged cells |
| `image` | `assetId`, optional `alt` | `assetId`: canonical decimal-string asset ID (DB id, not a file name); `alt` ≤500 characters |

Valid example:

```json
{
  "blocks": [
    { "type": "text", "text": "Решите уравнение:" },
    { "type": "formula", "latex": "x^2 - 5x + 6 = 0", "display": true },
    { "type": "chemistry", "formula": "\\ce{H2SO4 + 2NaOH -> Na2SO4 + 2H2O}" },
    { "type": "verse", "lines": ["Ба кӯҳсор рафтам,", "Ба дарё расидам."] },
    { "type": "table", "rows": [["x", "y"], ["1", "2"]] },
    { "type": "image", "assetId": "42", "alt": "Рисунок 3" },
    { "type": "text", "text": "Выберите ответ", "marks": ["bold"] }
  ]
}
```

Rejected:

```json
{ "blocks": [] }
{ "blocks": [{ "type": "text", "text": "x", "html": "<b>x</b>" }] }
{ "blocks": [{ "type": "paragraph", "text": "x" }] }
{ "blocks": [{ "type": "image", "src": "page12.png" }] }
{ "blocks": [{ "type": "text", "text": "   " }] }
{ "blocks": [], "version": 1 }
```

- The first is rejected only where content is required (question and items); it is valid for an explanation.
- The others are rejected everywhere.
- `paragraph`, `heading`, `list` and similar are **lesson** blocks (M07-B) and are not valid in questions.

---

## 3. Question types

| Type | Structure fields | `interactionSettings` | `answerData` (key) |
|---|---|---|---|
| `single_choice` | `options` required, 2–10 | `{}` | `{ "optionKey": "b" }` (existing key) |
| `multiple_choice` | `options` required, 2–10 | `{}` | `{ "optionKeys": ["a","c"] }` (non-empty, distinct, existing) |
| `matching` | `matching: { left[1–20], right[1–20] }` required | `{ "requireAllLeft": bool, "allowRightReuse": bool }`, both required | `{ "pairs": [{ "left":"1", "right":"a" }] }`: each left at most once; every left when `requireAllLeft`; distinct rights unless `allowRightReuse` |
| `numeric` | no options or matching | `{}` | `{ "value": 3.5 }` (finite number, exact; **no tolerance**) |
| `short_text` | no options or matching | `{}` | `{ "acceptedAnswers": ["Душанбе","Dushanbe"] }` (1–20 distinct non-blank strings ≤500; **no normalization rules defined**) |

- Sending `options` or `matching` for a type that does not use them returns `400`. Any non-empty `interactionSettings` for a non-matching type returns `400`.
- `answerData` references item **keys** (`option_key`, `item_key`), never row IDs. Extra keys inside `answerData` return `400 ANSWER_KEY_INVALID`.

Key statuses:

| Status | Meaning | `source` | `answerData` |
|---|---|---|---|
| `unknown` | no answer known | `none` | `null` |
| `proposed` | an answer was supplied but nobody attested it | `official_key`, `expert_review` or `ai_inference` | required, validated |
| `verified` | a reviewer (`questions.review`) attested a proposed key | `official_key` or `expert_review` only (never `ai_inference`) | required; `verified_by`/`verified_at` set |

- Authors set `unknown`/`proposed` through `PUT /admin/questions/:id/answer-key`. Only `POST .../answer-key/verify` creates `verified`.
- Publication requires `verified`.

Full create example (`POST /admin/question-banks/:bankId/questions`):

```json
{
  "questionType": "matching",
  "externalId": "bio-9-p34-n7",
  "languageCode": "tg",
  "difficulty": 3,
  "difficultySource": "official",
  "content": { "blocks": [{ "type": "text", "text": "Мувофиқ кунед" }] },
  "interactionSettings": { "requireAllLeft": true, "allowRightReuse": false },
  "matching": {
    "left": [
      { "key": "1", "sourceLabel": "1)", "content": { "blocks": [{ "type": "text", "text": "Ҳуҷайра" }] } },
      { "key": "2", "sourceLabel": "2)", "content": { "blocks": [{ "type": "text", "text": "Бофта" }] } }
    ],
    "right": [
      { "key": "a", "sourceLabel": "А)", "content": { "blocks": [{ "type": "text", "text": "Воҳиди сохтор" }] } },
      { "key": "b", "sourceLabel": "Б)", "content": { "blocks": [{ "type": "text", "text": "Гурӯҳи ҳуҷайраҳо" }] } }
    ]
  },
  "topicIds": ["15"],
  "sourceMetadata": { "book": "Биология 9", "edition": "2021", "page": 34, "number": "7" }
}
```

Followed by `PUT .../answer-key`:

```json
{ "answerData": { "pairs": [{ "left": "1", "right": "a" }, { "left": "2", "right": "b" }] }, "source": "official_key" }
```

---

## 4. Images

| Question | Current answer |
|---|---|
| Allowed assets | `status = 'ready'` and `mime_type` `image/png` or `image/jpeg`. `kind` is not checked; images are uploaded as `kind: "material"` (`.png`, `.jpg`, `.jpeg`) |
| Who may embed | the uploader of the asset; anyone managing the bank when the asset is already used by a question of the **same bank**; any administrator (owner/admin role). Otherwise `422 QUESTION_ASSET_NOT_USABLE` |
| Course binding | the **question** rule does not look at any course. The **upload** API does: `POST /assets/uploads` requires `courseId` of a non-archived course the uploader may manage (`assets.upload` or assigned teacher with `canManageLessons`) |
| Asset without a course | cannot be created through the API today. There is no bank-bound upload path (deferred to M09 by decision M08 #10) |
| Upload flow | `POST /assets/uploads` `{ courseId, kind: "material", fileName, mimeType, sizeBytes }` → `POST /assets/uploads/:id/parts` → client PUTs the bytes → `POST /assets/uploads/:id/complete` (magic-byte check) → `asset.id` |
| Link to a question | put `{ "type": "image", "assetId": "<asset.id>", "alt": "…" }` in any content. `question_assets` is derived automatically |
| Publication | every linked asset must still be usable/ready, otherwise `409 QUESTION_NOT_PUBLISHABLE` (`ASSET_NOT_READY`) |
| Dedup by content | not available: `assets.sha256` is never filled by uploads |
| Package-local file IDs | `asset_aliases` exists in the schema but has no code |

---

## 5. Question statuses

There is **no `ready` status**. The DB CHECK allows only `draft`, `published` and `archived`. Readiness is expressed by the key status (`proposed` vs `verified`), not by the question status.

| Transition | Who | Conditions |
|---|---|---|
| create → `draft` | bank manager (`questions.manage` + owner of the bank, or administrator) | always `draft` |
| edit `draft` | bank manager | any edit returns a `verified` key to `proposed`; if referenced keys disappear, the key is reset to `unknown` (the explanation is kept) |
| `draft` → `published` | `questions.review` (owner/admin) | verified key, key still valid against the items, assets ready; also enforced by the `questions_guard` trigger (verified key, ≥2 options for choice types, matching items/settings) |
| `published` → `archived` | `questions.review` | one-way |
| any change to `published`/`archived` | nobody | `409 QUESTION_IMMUTABLE` (API) and `QUESTION_IMMUTABLE` (trigger) |
| correct a published question | bank manager | `POST /admin/questions/:id/copy` creates a new draft with `source_question_id`, `external_id = NULL`, and the key copied as `proposed`/`unknown` |
| delete | bank manager | drafts only, not referenced by copies, tests or duplicate links |

Decisions on record (documentation.md §13, decisions M08): unreviewed imports stay `draft`, unknown answers stay `unknown`, and imports never publish.

---

## 6. Natural keys for idempotent upsert

| Entity | Natural key in the schema | Enforced | Notes for M09 |
|---|---|---|---|
| subject | `code` | UNIQUE | usable |
| section | (`subject.code`, `code`) | UNIQUE (`subject_id`, `code`) | usable |
| topic | (`subject.code`, `code`) | UNIQUE (`subject_id`, `code`) | usable; `parent` referenced by code; order parents first |
| translation | (entity, `language_code`) | PK | usable; the API replaces the full set |
| bank | `code` | UNIQUE (global) | usable |
| question | (`bank.code`, `external_id`) | UNIQUE (`bank_id`, `external_id`) | **`external_id` is nullable**, so M09 must require it for imported rows. Upsert is only possible while the row is `draft`; a published match must be skipped or copied |
| option / matching item | (question, key), (question, side, key) | UNIQUE | usable; written as a full replacement list |
| answer key | `question_id` | PK | usable (draft only) |
| question topic | (question, topic) | PK | full replacement |
| asset | none | — | needs `asset_aliases (source_namespace, external_id)` code, or a filled `sha256` |
| question asset | derived | — | do not import directly |
| duplicate link | (`question_id`, `duplicate_of_id`) | PK | no API; `marked_by` NOT NULL |
| import run | (`bank_id`, `idempotency_key`) | UNIQUE | schema ready, no code |

---

## 7. Package `everest.question-import.v1` → database

No package schema is defined in this repository. The package field names below are **proposed** camelCase names that map one-to-one to columns. Status legend:

- **ok**: maps to an existing column.
- **derived**: computed by the backend.
- **missing**: needs a migration or a decision.

### subjects / subject_translations

| Package field | DB column | Status |
|---|---|---|
| `subjects[].code` | `subjects.code` | ok (natural key) |
| `subjects[].primaryLanguage` | `subjects.primary_language` | ok |
| `subjects[].color` | `subjects.color` | ok (palette only) |
| `subjects[].translations.{lang}.title` | `subject_translations.title` | ok |
| `subjects[].translations.{lang}.description` | — | missing (no description column) |

### sections / section_translations

| Package field | DB column | Status |
|---|---|---|
| `sections[].subjectCode` | `sections.subject_id` | derived (lookup by code) |
| `sections[].code` | `sections.code` | ok |
| `sections[].primaryLanguage` | `sections.primary_language` | ok |
| `sections[].translations.{lang}.title` | `section_translations.title` | ok |
| `sections[].position` / order | — | missing (sections and topics have no order column; lists are sorted by code) |

### topics / topic_translations

| Package field | DB column | Status |
|---|---|---|
| `topics[].subjectCode` | `topics.subject_id` | derived |
| `topics[].code` | `topics.code` | ok |
| `topics[].sectionCode` | `topics.section_id` | derived (same subject) |
| `topics[].parentCode` | `topics.parent_id` | derived (same subject, no cycles) |
| `topics[].primaryLanguage` | `topics.primary_language` | ok |
| `topics[].translations.{lang}.title` | `topic_translations.title` | ok |

### question_banks

| Package field | DB column | Status |
|---|---|---|
| `bank.code` | `question_banks.code` | ok (natural key) |
| `bank.title` | `question_banks.title` | ok |
| `bank.subjectCode` | `question_banks.subject_id` | derived; immutable |
| `bank.visibility` | `question_banks.visibility` | ok |
| `bank.source.{book,edition,note}` | `question_banks.source_metadata` | ok (allowlist §1.4) |
| `bank.owner` | `question_banks.owner_id` | derived: the importing user (NOT NULL) |

### questions

| Package field | DB column | Status |
|---|---|---|
| `questions[].externalId` | `questions.external_id` | ok, but nullable in the DB; must be required by M09 |
| `questions[].type` | `questions.question_type` | ok |
| `questions[].language` | `questions.language_code` | ok |
| `questions[].difficulty`, `difficultySource` | `difficulty`, `difficulty_source` | ok (both or neither) |
| `questions[].content` | `questions.content` | ok (§2; image `assetId` must be resolved to a DB id) |
| `questions[].interactionSettings` | `questions.interaction_settings` | ok |
| `questions[].source.{book,edition,page,number,note}` | `questions.source_metadata` | ok (other keys rejected) |
| `questions[].status` | `questions.status` | derived: always `draft` |
| — | `questions.import_id` | derived (column exists, no code) |
| — | `questions.created_by` | derived: the importing user |
| `questions[].translations` | — | missing (a question has exactly one language) |

### question_options / question_matching_items

| Package field | DB column | Status |
|---|---|---|
| `options[].key` | `question_options.option_key` | ok |
| array order | `question_options.position` | derived |
| `options[].label` | `question_options.source_label` | ok (≤50) |
| `options[].content` | `question_options.content` | ok |
| `options[].isCorrect` | — | **rejected by design**; use the answer key |
| `matching.left[] / right[]` (`key`, `label`, `content`) | `question_matching_items.side/item_key/source_label/content` | ok |

### question_answer_keys

| Package field | DB column | Status |
|---|---|---|
| `answerKey.answerData` | `answer_data` | ok (§3) |
| `answerKey.source` | `source` | ok for `official_key`, `expert_review`, `ai_inference` |
| `answerKey.status = proposed\|unknown` | `status` | ok |
| `answerKey.status = verified` | `status`, `verified_by`, `verified_at` | needs a decision: verification requires a reviewer action and never comes from a file |
| `answerKey.explanation` | `explanation` | ok |

### question_topics / assets / question_assets / question_duplicate_links

| Package field | DB column | Status |
|---|---|---|
| `questions[].topicCodes[]` | `question_topics.topic_id` (+ `subject_id`) | derived (lookup by code; same subject; ≤20) |
| `assets[].id` (package-local) | `asset_aliases.external_id` | missing code (table exists) |
| `assets[].file` (bytes) | object storage + `assets.storage_key` | missing: a bank-bound upload/import path (uploads require `courseId`) |
| `assets[].mimeType` | `assets.mime_type` | ok (PNG/JPEG for questions) |
| `assets[].fileName` | `assets.file_name` | ok |
| `assets[].sha256` | `assets.sha256` | column exists, not filled or verified by current code |
| `assets[].page` | `assets.source_metadata` | no contract defined |
| — | `question_assets` | derived from image blocks |
| `duplicates[].{externalId, duplicateOf, reason}` | `question_duplicate_links` | missing code; `marked_by` = importing user |
| `package.idempotencyKey`, `sha256`, `schemaVersion`, `dryRun`, `manifest` | `question_imports.*` | missing code (table exists) |
| per-record errors | `question_import_errors` | missing code (table exists) |

---

## 8. Gaps: what cannot be imported without backend changes

1. **No import pipeline.** `question_imports` and `question_import_errors` have no repository, service, route, dry run, idempotency handling or counters. `questions.import_id` is never set.
2. **No `ready` status.** Only `draft`, `published` and `archived` exist. A "ready" state needs a migration or must be expressed as key status `proposed`/`verified`.
3. **`external_id` is optional.** Idempotent re-import requires M09 to make it mandatory for imported questions (API rule or a partial constraint).
4. **Re-import of published questions** cannot update them (immutable). A policy is needed: skip, copy, or report.
5. **Verified keys cannot come from a file.** `verified` needs `verified_by`/`verified_at` and a reviewer action. Book keys can be imported only as `proposed` with `source = official_key`.
6. **Images:**
   - uploads require a `courseId`, and there is no bank-bound upload path;
   - `asset_aliases` has no code;
   - `assets.sha256` is not filled, so content deduplication is impossible;
   - content must reference DB asset IDs, so the package needs a local-ID → asset-ID resolution step.
7. **Book pages:** there is no page table or page-image contract; only `source_metadata.page` (integer).
8. **Duplicate detection and links:** `question_duplicate_links` has no API and no detection logic.
9. **Taxonomy:**
   - no ordering column for sections and topics;
   - no translated descriptions;
   - no external IDs (codes are the only keys).
10. **`source_metadata` is an allowlist** (`book`, `edition`, `page`, `number`, `note`). Fields such as chapter, variant or year are rejected until the allowlist is extended.
11. **Content model limits:**
   - no inline markup inside `text` (marks apply to the whole block);
   - no inline formulas inside text;
   - no table header or merged cells;
   - no per-question translations (one `language_code` per question).
12. **Grading semantics are undefined:** numeric tolerance and short-text normalization (decision M08 #4).
13. **Ownership:** `question_banks.owner_id` and `questions.created_by` are NOT NULL, so every import run must act as a concrete user with `questions.manage`.

---

## 9. Implemented package format `everest.question-import.v1` (M09)

A package is a **directory** or a **ZIP file** with `manifest.json` at its root. A ZIP that wraps everything in one top-level folder is also accepted. Image files sit next to the manifest, for example `assets/fig-3.png`.

Package limits:

- ZIP: stored or deflate entries only. ZIP64, encrypted entries and paths containing `..`, `\`, an absolute prefix or a drive prefix are rejected (`PACKAGE_ARCHIVE_INVALID`).
- Size: at most 512 MiB per package and 64 MiB per entry.
- Package hash:
   - a ZIP is hashed as the sha256 of the file bytes;
   - a directory is hashed as the sha256 of the sorted `path NUL sha256(file) LF` lines, so the hash does not depend on timestamps or file system order.

Top level (unknown keys return `PACKAGE_FIELD_UNKNOWN`):

| Field | Required | Rules |
|---|---|---|
| `schemaVersion` | yes | exactly `everest.question-import.v1` |
| `sourceNamespace` | no | `^[a-z0-9][a-z0-9:._-]{0,99}$`; default `bank:<bank.code>`. It scopes `asset_aliases` |
| `subjects[]` | no (≤100) | `{ code, primaryLanguage?='tg', color?='neutral', translations }` |
| `sections[]` | no (≤1000) | `{ subjectCode, code, primaryLanguage?, translations }` |
| `topics[]` | no (≤10000) | `{ subjectCode, code, sectionCode?, parentCode?, primaryLanguage?, translations }` |
| `bank` | yes | `{ code, title, subjectCode, visibility?='private', source? }` (`source` uses the `sourceMetadata` allowlist) |
| `assets[]` | no (≤20000) | `{ id, file, mimeType, sha256?, fileName? }` |
| `questions[]` | no (≤20000) | see below |

Field rules:

- `translations` = `{ tg|ru|en: { title } }` (1–200 characters). The primary-language title is required.
- Codes follow the M08 patterns.
- Subjects, sections and topics referenced by code may already exist in the database instead of being declared in the package.

Question fields:

| Field | Maps to | Notes |
|---|---|---|
| `externalId` | `external_id` | **required**, 1–200, unique in the package |
| `type` | `question_type` | the 5 M08 types |
| `language` | `language_code` | default `tg` |
| `difficulty`, `difficultySource` | same | both or neither |
| `content` | `content` | §2 blocks; image blocks are `{ "type": "image", "asset": "<assets[].id>", "alt"? }`. A raw `assetId` returns `IMAGE_REFERENCE_INVALID` |
| `interactionSettings` | same | matching only |
| `options[]` | `question_options` | `{ key, label?, content }`; `label` → `source_label`; `isCorrect` returns `OPTION_IS_CORRECT_REJECTED` |
| `matching.{left,right}[]` | `question_matching_items` | same item shape |
| `topicCodes[]` | `question_topics` | ≤20 distinct topics of the bank subject |
| `source` | `source_metadata` | allowlist `book, edition, page, number, note, chapter, variant, year` |
| `answerKey` | `question_answer_keys` | `{ status: unknown\|proposed, source?, answerData?, explanation? }`; `verified` returns `ANSWER_KEY_VERIFIED_REJECTED`; missing means `unknown` |

Every question is converted to the M08 API body and validated by the same functions as `POST /admin/question-banks/:bankId/questions`. As in the API, one question reports its **first** error.

### Re-import rules

- **Question** (`bank.code`, `externalId`):
   - none → create a draft;
   - a draft → replace it in place (content, items, topics, metadata; derived images);
   - published or archived → skip with warning `QUESTION_IMMUTABLE_SKIPPED`;
   - a stored draft of another type → `QUESTION_TYPE_CHANGED`.
- **Answer key on update:**
   - a `proposed` package key replaces the stored key;
   - an `unknown` package key keeps an existing stored key (author or reviewer work). A verified key then returns to `proposed`, and a key that no longer fits becomes `unknown` (the M08 reconcile rule).
- **Taxonomy:**
   - missing entities are created; this needs `taxonomy.manage`, otherwise `TAXONOMY_PERMISSION_REQUIRED`;
   - existing ones only get translation upserts (with `taxonomy.manage`, otherwise warning `TAXONOMY_TRANSLATION_SKIPPED`);
   - differing structure (primary language, color, section, parent) is kept as stored, with warning `TAXONOMY_FIELD_MISMATCH`;
   - nothing is ever deleted.
- **Bank:**
   - created with the actor as owner;
   - an existing bank must belong to the actor (or the actor is an administrator), otherwise `QUESTION_BANK_READ_ONLY`;
   - it must have the same subject, otherwise `BANK_SUBJECT_MISMATCH`;
   - its title and visibility are never changed (warning `BANK_FIELD_MISMATCH`).
- **Asset**, in this order:
   1. alias (`sourceNamespace`, `id`) with equal bytes → reuse. An alias with other bytes returns `ASSET_ALIAS_CONFLICT`.
   2. A stored asset with the same sha256 → reuse and add an alias.
   3. Otherwise upload and create the alias.
- **Duplicate suggestion:** a question in the same bank with the same type, the same normalized content text (NFKC, lower case, collapsed whitespace) and the same unordered set of option/item texts gets a `question_duplicate_links` row. The new question points to the earliest one, with `marked_by` = actor. Nothing is merged or skipped.

### Content the model cannot express

Such content is mapped to the closest valid form and a warning is stored:

| Package pattern | Mapping | Warning |
|---|---|---|
| `table.header` flag | flag dropped; the first row stays a normal row | `CONTENT_TABLE_HEADER_FLATTENED` |
| `questions[].translations` | ignored; only `language` is imported | `QUESTION_TRANSLATIONS_IGNORED` |
| `answerKey.tolerance` / `answerKey.normalization` | ignored (M10/M11) | `GRADING_RULE_IGNORED` |
| a declared asset no question uses | stored anyway | `ASSET_UNUSED` |

A minimal valid package is `tests/fixtures/question-import/sample/` (synthetic).

---

## 10. Gap status after M09

| §8 gap | Status |
|---|---|
| 1. No import pipeline | **closed**: CLI, planner, dry run, recorded runs, errors/warnings, counters, `questions.import_id` |
| 2. No `ready` status | **kept by design**: readiness is the key status (`proposed`/`verified`) |
| 3. `external_id` optional | **closed for imports**: required by the importer (the column stays nullable for M08 authoring and copies) |
| 4. Re-import of published questions | **closed**: skip and report `QUESTION_IMMUTABLE_SKIPPED`, never copy or modify |
| 5. Verified keys from a file | **closed**: rejected; at most `proposed` |
| 6. Images | **closed** at the service level: CLI upload without `courseId`, `sha256` filled, dedup by unique sha256, `asset_aliases` resolution. **Open:** no HTTP bank-bound upload endpoint; real S3/MinIO import not verified |
| 7. Book pages | **open by design**: `source_metadata.page` only |
| 8. Duplicate detection | **closed (conservative)**: exact normalized match, suggestion only. **Open:** no API to list or resolve links; a linked draft cannot be deleted (`QUESTION_IN_USE`) |
| 9. Taxonomy ordering, descriptions, external IDs | **open**: codes are the keys; lists stay sorted by code |
| 10. `source_metadata` allowlist | **closed**: `chapter`, `variant`, `year` added (strict, length-limited) |
| 11. Content model limits | **open**: no inline markup or formulas, no table header or merged cells, no per-question translations (mapped with warnings) |
| 12. Grading semantics | **open** (M10/M11) |
| 13. Ownership | **closed**: the CLI requires an existing active user with `questions.manage` |
