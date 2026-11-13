# Decisions

## 2026-11-15 — Video player backend (chapters, progress, cached playback, offline keys, watermark)

- **Built on what existed.** Chapters (`lesson_video_chapters`), progress (`lesson_progress`), playback and offline licenses (`offline_downloads`) were already there; this increment extends them. Migration `20261115010000000_add-video-player-state` adds only `lesson_progress.watched_ranges`/`last_reported_at`, table `offline_devices` and nullable `offline_downloads.device_id`.
- **Chapters on video replacement: cleared, not marked.** Times belong to one recording; keeping or flagging them would show wrong markers to learners or need a second state. Replacement clears them in the same transaction (audit `chaptersCleared`); removing a video with chapters is still refused (`LESSON_HAS_CHAPTERS`), so a mistaken removal does not drop them. `CHAPTERS_EXCEED_VIDEO_DURATION` is gone. Title limit 1–120 for new writes; the database check stays 200 so existing rows remain valid.
- **Progress counts unique time.** The client sends played `[start, end)` intervals; the server merges them and completes at 90% of the known duration. The old `watchedSeconds` input is accepted and ignored (old clients keep saving positions but cannot complete by a single number). `watched_seconds` stays monotonic for display. Report interval 10 s (`PROGRESS_MIN_INTERVAL_SECONDS`), measured with the database clock, checked after the revision so a stale client first learns the revision. Intervals are trusted as reported (no server-side heartbeat); this blocks seek-to-end, not a forged client.
- **Stable playback URL.** `signingDate` = now rounded down to `VIDEO_PLAYBACK_URL_WINDOW_SECONDS` (6 h); lifetime = window + `VIDEO_PLAYBACK_URL_TTL_SECONDS` (2 h, so a URL issued at the end of a window still lives 2 h); `ResponseCacheControl: private, max-age=<lifetime>`. max-age is constant because any per-request value would change the signed URL. Access is checked on every call as before; a revoked learner can keep using an already issued URL until it expires (at most 8 h, was 2 h). Range works because only `host` is signed (unit test against the real presigner).
- **Offline: devices instead of sessions, keys derived.** Session-bound licenses broke on every new login and had no key. Now the app registers a random UUID per installation (`offline_devices`, limit `OFFLINE_MAX_DEVICES` = 2 counted at registration; sessions holding older session-bound licenses count too); a license may be bound to a device and is then usable from any session presenting that id. Key = HMAC-SHA256(`OFFLINE_KEY_SECRET`, `everest-offline-key|v1|user|device|asset|license`), returned as a raw AES-GCM 256 key, never stored; renewal keeps the license id, so the key and the stored file stay valid. Rotating the secret makes all offline files undecryptable (documented in env). Lease `OFFLINE_LICENSE_DAYS` = 14 (was 3), bounded by the enrollment/module grant expiry. Session-bound licenses remain for older builds (no key).
- **Revocation at end of access.** Revoking an enrollment or a module grant revokes the matching licenses in the same transaction (`access_lost`); expiry is covered by the lease bound; other cases (video replaced, lesson unpublished) are still caught lazily on the next license check.
- **Watermark.** First name + masked primary phone (`+992 *** 45`); `ID <userId>` when neither exists. Nothing else about the user is returned.
- **Staff summary.** `GET /admin/courses/:courseId/lessons/:lessonId/progress` under `lessons.read` and the course read scope; names only, every current enrollment of the course, capped at 2000 rows (no pagination yet).

## 2026-11-11 — Single-host production deployment

- Docker Compose (project `everest`) behind the host's existing nginx and certbot; no second reverse proxy, because ports 80/443 are shared with another site. Images are built on the server; no registry or CI for now.
- Storage is SeaweedFS (pinned tag) in the same stack; only its S3 port is published, on loopback. CORS comes from the bucket rule written by `storage:configure`, not from nginx.
- The app host routes `/api/v1/` directly to the backend (one proxy hop), so `TRUST_PROXY=loopback,172.16.0.0/12` gives the real client IP.
- `worker-attempts` is required; `worker-imports` runs too because admin web imports depend on it.
- Memory limits fit about 2.3 GB for EVEREST on a 3.7 GB host shared with another project.
- Local dumps stay unencrypted with mode 600; off-site copies (Backblaze B2 through rclone) are encrypted with an age public key.

## 2026-11-11 — Client IP behind a reverse proxy (`TRUST_PROXY`)

- Behind nginx and Docker every request reached Express from the proxy or Docker gateway address, so the per-IP limits (`login.ip`, `refresh.ip`, `recovery.*.ip`, `register.ip`) were shared by all clients.
- `TRUST_PROXY` sets Express `trust proxy`. Accepted: unset/`false` (default), a hop count, or a list of names/IPs/CIDRs. `true` is rejected because it would believe any client-supplied `X-Forwarded-For`. Invalid values stop startup with a clear error.
- An address list is preferred over a hop count: Express returns the right-most address that is not trusted, so entries a client forges on the left are ignored. For the Docker-plus-host-nginx layout the value is `loopback,172.16.0.0/12`.
- The edge proxy should overwrite `X-Forwarded-For` with `$remote_addr` instead of appending; the list setting stays correct either way.
- In production without `TRUST_PROXY` the server logs a warning at startup.

## 2026-11-08 — Presigned URLs for question images

- **Response only.** `url`/`expiresAt` are added to a copy of the content when a response is built and are never written. On input the parser accepts and drops them, so a client can send back what it received.
- **Who may get a link.** The service that builds the response has already checked access: the admin read scope of the bank, or the learner's own attempt (`findAttempt(actorId, …)`). On top of that, an asset is signed only when it is `ready`, PNG/JPEG and linked to the same question in `question_assets`. An image block naming any other asset gets no URL.
- **One query per response.** `listQuestionImageAssets(questionIds)` reads every linked image of the response at once. Signing is local (no storage call).
- **Failure is not an error.** Missing storage configuration or a signing error leaves the block without `url`/`expiresAt`; the request still succeeds.
- **Lifetime** 5 minutes, the same as lesson materials. `S3_PUBLIC_ENDPOINT` is applied by the storage provider, as for lessons.
- **Not included:** bank question lists and the staff attempt view.

## 2026-11-08 — Bulk verify and publish (`verify:keys`, `publish:questions`)

- **Same path as the buttons.** Writes go through `verifyAnswerKeyService` and `publishQuestionService` inside the batch transaction. Their checks were moved into shared functions (`answerKeyVerificationBlocker`, `questionPublicationBlocker`), so a dry run uses the same rules without writing. The HTTP endpoints behave as before.
- **Actor.** An active account with `questions.review`, the permission the admin buttons check (owner/admin by seed). Not `questions.manage`, which teachers also hold.
- **Verification source** is the key's proposed source. `ai_inference` proposals are skipped (`SKIPPED_SOURCE_NOT_VERIFIABLE`): turning an AI guess into `expert_review` is a human decision.
- **Run record.** No table and no migration: `runId` is a UUID in audit metadata (`question_bulk_<kind>.started/.completed` on the bank, and every per-question event). Bulk audit is written only when something changes, so a repeated run adds no rows. The full per-question report exists only in the `--report` file.
- **Errors.** A refusal from the service (an `AppError`, thrown before any write) is a per-question outcome and the batch continues. Any other error rolls the batch back, marks its questions `FAILED` / `BATCH_ROLLED_BACK` and stops the run.
- **Not included:** setting matching rules. That stays in `import:answer-keys --set-matching-rules` or the admin edit.

## 2026-11-08 — Answer keys from a sidecar file (`import:answer-keys`)

The owner was away; every open choice below was settled deny-by-default and can be changed.

- **Path.** Keys are written by `replaceAnswerKeyService` (the service behind `PUT /admin/questions/:id/answer-key`), and matching rules by `updateQuestionService` (the `PATCH` draft edit). Both run inside the importer's batch transaction (their `transaction` dependency receives the batch client). The validation, the draft-only rule, the bank-manage rule and the audit rows are the API's own. The importer adds no SQL around them.
- **Only `proposed`.** The file may carry `proposed` with `official_key` or `expert_review`. `verified`, `unknown` and `ai_inference` reject the whole file. Nothing is verified or published.
- **No overwrite.** A stored proposed key with other data or another source is `KEY_CONFLICT`: it is kept, and both values go to the report file only. A verified key is never touched. Equality ignores pair and option order. It compares answer data and source, not the explanation.
- **Explanation.** An empty file explanation keeps an explanation already stored on the draft. A non-empty one replaces it. Image blocks are refused (`EXPLANATION_INVALID`), because a key file cannot carry assets.
- **Grading rules.** A record whose `answerDataExternal` carries tolerance, unit or normalization is `ANSWER_KEY_INVALID`. Applying it without them would change grading silently.
- **Run record, no migration.** `question_imports` already fits: `package_sha256` = sha256 of the key file, `schema_version = everest.answer-key-import.v1`, `manifest` holds `keySource` and `sourcePackage`, `counters` the outcomes. The unique `(bank_id, idempotency_key)` gives idempotency. The default key is `answer-keys-<sha256>`, plus `-matching-rules` with the flag, because the flag changes what is written. Stored entries are the non-applied outcomes and failed batches, with messages only (no answer data). These runs are visible in `GET /admin/question-imports`.
- **Batches.** Up to 100 records per transaction. After a failed batch, later batches are not attempted (as in `import:questions`). Replaying the same key returns the failed run; a retry uses a new key and reports already-set keys as `UNCHANGED`.
- **Actor.** The same rule as `import:questions` (`loadImportActor`): an active user with `questions.manage` who owns the bank, or an owner/admin.
- **Matching rules (`--set-matching-rules`, alias `--set-allow-right-reuse-false`).**
   - Opt-in, and only for draft matching questions whose key is `APPLIED` or `UNCHANGED` in this run.
   - Each field is decided on its own: `requireAllLeft` `null` → `true` only when the key pairs every left item; `allowRightReuse` `null` → `false` only when the right items are distinct. It is never set to `true`. A stored boolean is never changed.
   - Reason: the book prints no rule, but every official key covers all left items with distinct right items, so these are the strictest rules consistent with the key.
   - In practice `RIGHT_REUSE_SKIPPED_NOT_DISTINCT` cannot happen after a successful key write: with the rule `null`, the validator already refuses reused right items (`ANSWER_KEY_INVALID`). The branch is kept and unit-tested.
   - `stillNull` and `publishableBySettings` count every draft matching question of the bank, not only the keyed ones.
- **`NO_KEY_FOR_QUESTION`** lists every question of the bank without a record, whatever its status.
- **Not checked against `everest_db`.** The Tajik bank `nct-tg-2026` is not imported in the local `everest_db` yet, so its stored values (`requireAllLeft: true`, `allowRightReuse: null` expected from the adapter) were not read. The command reads the real stored values per question and does not depend on that expectation.

## 2026-11-08 — A lesson with a test completes only by its test; staff `passed`

**Bypass found in code.** `saveLessonProgressService` accepted `{ completed: true }` for any lesson without a video, and completed a video lesson at 90% watched. Both worked for a lesson with `test_id`, so a student could finish it without passing the test. No other path writes `lesson_progress` for a student; `completeTestLessons` is the test path.

**Rule now (owner's rule: only the test result completes such a lesson):**

- For a lesson with `test_id`, `completed: true` and any write to a lesson without a video are refused with `409 LESSON_COMPLETES_BY_TEST`.
- On a lesson with a video and a test, watch progress (`playbackSeconds`, `watchedSeconds`) still saves as `in_progress`, and the 90% rule no longer completes it. A completion already written by a test result is kept and is never undone.
- Lessons without `test_id` work as before.
- **Fork, strictest option chosen (not guessed).** For a mixed lesson (video and test) one could instead require both 90% watched and a passed test. The request says to build the strictest variant, so completion needs only the test, and watching does not count. Changing it later means adding the 90% condition to `completeTestLessons`.
- Completions that students already obtained through the old bypass are kept; nothing was reset.

**Staff `passed`.** `attemptPassed` in `utils/attempt-policy.js` is the only pass formula; the learner result and the staff list and detail both use it.

- It is `true` or `false` for a finished attempt (`graded`, `expired`) with a snapshot `passPercent`, using `percent >= passPercent`.
- It is `null` without `passPercent`, or while the attempt is in progress or cancelled.
- A finished attempt with `maxScore` 0 is `false`.
- `attemptCompletesLesson` was not changed and keeps its own timer rule.

## 2026-11-08 — Teachers may grant extra attempts

**Owner's decision (2026-11-08):** a teacher can grant extra attempts to students of their own groups; admin and owner as before.

- Migration `20261108010000000_grant-teacher-attempt-grant-permission.js` binds `tests.attempts.grant` to the `teacher` role. `down` removes only that binding. This resolves the open question from the previous PR.
- **Scope, verified in code (`grantScopeSql`):** owner and admin see every assignment. A teacher sees an assignment only when it is made to a group (`assignment.group_id`) where they hold a `group_teachers` row with `can_view_results`.
- **Other ways into scope.** None grant anything:
   - a `course_teachers` row, even with `can_view_results`, gives no right to grant;
   - a direct (single-student) assignment has no group, so only owner and admin can grant on it;
   - a group teacher without `can_view_results` is out of scope;
   - a student cannot grant, because the permission check fails first (`403`).
- Out-of-scope teachers get `404 ASSIGNMENT_NOT_FOUND`, the same as a missing assignment. The `GET` follows the same scope.
- The audit event `test.attempts_granted` and the `granted_by` column record the teacher.
- **Note:** results scope (`tests.results.read`) lets a course teacher see all attempts of the course's tests, while granting is narrower and group-only. This is deliberate and follows the 2026-11-07 request ("own group").

## 2026-11-07 — Extra attempts per student (M11)

**Owner's decisions (given on 2026-11-07):**

1. Extra attempts are granted by the roles that can regrade, through the new permission `tests.attempts.grant`: owner and admin everywhere, a group teacher only for their own group (as in results scope).
2. A grant applies to one (assignment, student) pair. A group assignment stays shared; the grant is for one student.
3. A grant only adds attempts and cannot be withdrawn. Existing attempts and scores are not edited.
4. Effective limit = the assignment's `max_attempts` plus the sum of that student's grants on it. The original limit and other students are unchanged. With `max_attempts = null`, a grant is a validation error.
5. A grant never reopens a window: a revoked or closed assignment, or a passed `closes_at`, refuses new attempts with a clear code. The window is not extended.
6. Keys stay hidden while the student has attempts left, counting grants.
7. Lesson completion is unchanged (`lesson-completion-service`).

**Choices made here, unattended; please review:**

- **Who holds the permission.** The task says both "the same roles as `tests.results.regrade`" (owner and admin only) and "a group teacher for their own group". The migration follows the first: only owner and admin hold `tests.attempts.grant`.
   - The scope rule is built in: a teacher with the permission can grant only on assignments to a group they teach with `can_view_results`.
   - Course teachers and direct assignments are out of scope for teachers (`404`).
   - Giving teachers the permission is one `role_permissions` row. It was not added because of the contradiction.
- **Snapshot.** `policy_snapshot.maxAttempts` keeps the test's own limit, and new attempts store it the same way. Grants are read live and added in `effectiveMaxAttempts` (`utils/attempt-policy.js`, the single formula). Attempts created before a grant therefore need no rewrite.
   - Consequence: after a grant, an `after_submission` result that was already revealed becomes hidden again until the extra attempts are used.
- **Where the limit lives.** The limit is on the test (`tests.max_attempts`, joined as `assignment.max_attempts`). Published tests are immutable, so it cannot drift.
- **Student check.** The student must be the direct assignee or an active member of the assigned group (`409 STUDENT_NOT_ASSIGNED`). A student who left the group cannot start, so a grant would be useless.
- **Codes.**
   - `400 ATTEMPTS_UNLIMITED` is the validation error.
   - `409 ASSIGNMENT_REVOKED` is new.
   - `409 ASSIGNMENT_CLOSED` and `409 TEST_NOT_AVAILABLE` are reused.
   - An upcoming assignment can receive a grant.
- **Idempotency.**
   - As in regrade, the key is checked first, so a replay returns the current state even if the assignment has closed since.
   - `ON CONFLICT (idempotency_key) DO NOTHING` turns a concurrent duplicate into a replay or an `IDEMPOTENCY_KEY_CONFLICT`.
- **Races.** The grant takes the start's advisory lock for (student, assignment) plus `FOR SHARE` on the assignment. `createNewAttempt` reads the grants under that same lock.
- **Reads.** `GET` on the grant path uses the same permission and scope. The learner's `maxAttempts` also shows the effective limit, so it matches `remainingAttempts`.
- **Append-only** is enforced in code (there is no update or delete method), not by a trigger.
- **Catalog script.** `verify-database.js` still expected 34 permissions and 81 role grants, from before the regrade migration. It now expects 36 and 85, plus the new table.

## 2026-11-07 — M11 gaps: lesson completion by test, passPercent, history, testId, course progress

**Owner's decision on lesson completion (given by the owner on 2026-11-07):**

1. A lesson with `test_id` is completed by the server from the attempt result.
2. With `passPercent` set on the test, the lesson completes only when `passed = true`.
3. With `passPercent` `null`, any finished (submitted) attempt completes it.
4. An attempt closed by the timer without a single answer never completes the lesson, whatever `passPercent` is.
5. A completed lesson is never moved back: not by a worse retake and not by a regrade down. `completed_at` is never overwritten.
6. When the attempts run out and `passed` never became `true`, the lesson stays not completed. This is deliberate.
7. `max_attempts` does not change the rule and is not checked by it.
8. When a regrade makes `passed` `true`, the lesson completes by the same rule, in the same transaction as the regrade.

**Implementation choices made here, unattended; please review:**

- **One rule, one place.** `attemptCompletesLesson` and `completeTestLessonsService` (`src/services/lesson-completion-service.js`) are called from `finalizeAttempt` (submit, deadline on next access, autosave after the deadline, `worker:attempts`) and from `regradeAttemptService`, each with the transaction's client.
- **`passed`** uses `scorePercent(score, maxScore) >= policy_snapshot.passPercent`, the same comparison `readResult` reports. A `maxScore` of 0 never passes.
- **"Without a single answer"** = no `student_answers` row with a non-null `answer_data` for the attempt. Grading writes a row for every question, so the existence of a row means nothing. The rule is applied only to `expired` attempts, as stated; a manual submit with no answers and no `passPercent` completes the lesson.
- **Link.** Only `lessons.test_id`. `test_assignments.lesson_id` exists in the baseline but nothing writes it (M10 left lesson audiences unbuilt), so it is ignored. Every linked lesson is completed, whatever its status; the course progress counts only published, accessible ones.
- **Idempotency.** `INSERT ... ON CONFLICT DO UPDATE ... WHERE status <> 'completed'`: a completed row is not touched at all (same `completed_at`, same `revision`), and other rows get `completed_at = COALESCE(existing, now)` and `revision + 1`, so a player holding the old revision gets the existing conflict. Finalization runs once per attempt (row lock, `in_progress` check), and the idempotent regrade replay returns before it.
- **No migration.** `lesson_progress` already has everything needed.
- **passPercent.** `null` when the snapshot has none. Staff DTOs carry only `passPercent` (they already have `score` and `maxScore`).
- **History after revocation.** An assignment the learner no longer holds (revoked, or a group they left) is readable only when they have at least one attempt on it, and reports `state: 'revoked'` in the list, the lesson summary and the assignment result. Starts still use the active-only lookup, so nothing new can start. Leaving a group is treated like revocation and uses the same state value.
- **Reveal after revocation.** Unchanged: the snapshot policy, `closesAt` and the attempts the policy still allows. A revoked assignment with attempts left by policy keeps its keys hidden (until `closesAt`, or forever with no window), so revoking can never reveal keys early.
- **testId in lesson lists** follows the locked-content rule: `null` when the module is not granted.
- **Course progress** counts published lessons of published modules for which `can_access_module` is true now, in a `LATERAL` subquery of the same statement as the course list or card. `percent` is rounded down so 100 means all done. With an expired enrollment every module is locked, so progress reads `0 / 0` while the `lesson_progress` rows are kept.

## 2026-11-05 — M11 attempts, timing and grading

The user set the access, time, attempt, autosave, grading, reveal and endpoint rules. The following were chosen here, unattended; please review.

0. Decisions 1, 2, 3, 4 and 5 of the PR review were applied on the same branch; see items 7, 10, 13, 14 and 15.
1. **`test_attempts.expires_at` is `deadline_at`.** The column exists with this meaning, so no second column was added. The API calls it `deadlineAt`.
2. **Personal window needs no table.** Its start is the student's earliest `started_at` on the assignment. An advisory lock per student and assignment serializes starts. Changing `personalWindowMinutes` affects later starts only; running attempts keep their deadline.
3. **`deadlineAt` is fixed at start.** Moving `closesAt` later does not extend a running attempt, and moving it earlier does not shorten one.
4. **Attempt limits count per assignment**, as `UNIQUE (assignment_id, user_id, attempt_number)` implies. A student with both a direct and a group assignment gets both limits. Cancelled attempts do not count.
5. **`expired` is a finished status** that carries a score, so auto-submission stays visible. `graded` means the student submitted. `submittedAt` of an expired attempt is the deadline.
6. **Access is rechecked while an attempt runs.** Loading or saving an in-progress attempt needs the enrollment and module grant to remain active (`403`); submitting does not, so work is never trapped. A revoked assignment or a left group blocks new starts and resuming through `start`, but not an attempt already open by its id.
7. **Matching scores per pair.** The request said "per pair rules" and nothing else defines them: `correct / max(key pairs, sent pairs)`, rounded down. Extra pairs lower the share. `requireAllLeft` is not an extra penalty. Multiple choice stays all-or-nothing, because no schema or decision defines partial credit. Confirmed by the user.
8. **`shuffleOptions` also shuffles both matching columns.**
9. **Short text normalization** is Unicode NFC, trim and lower case. Inner spaces and punctuation are significant.
10. **Reveal uses the policy stored at start** and the live `closesAt`. With `after_submission`, keys, correct answers and explanations stay hidden while the student has attempts left on the assignment, and appear after the last attempt or when the window closes. With unlimited attempts only a closed window reveals. Score, percent and passed are always shown after submit. Confirmed by the user.
11. **`GET attempt` returns no questions once finished**, so review content follows the reveal policy in one place.
12. **Staff never receive answer keys** in attempt detail, following the question bank rule that only bank managers see keys.
13. **Results scope** is `course_teachers.can_view_results` (all attempts of the course's tests) or `group_teachers.can_view_results` (only attempts of assignments to that group). The user confirmed this.
14. **Regrade needs the new permission `tests.results.regrade`** (owner and admin only; migration `20261105040000000_add-results-regrade-permission.js`) plus results scope. It overrides points only; published keys are immutable, so automatic regrading could not change anything.
15. **A running attempt survives revocation** of its assignment or a left group: `start` resumes it and it ends at its deadline. Only new attempts are refused. Loss of the enrollment or module grant still stops it. Confirmed by the user.
16. **Audit events:** `test.attempt_started`, `test.attempt_submitted`, `test.attempt_expired` (no actor), `test.attempt_regraded`. Autosaves are not audited. Audit metadata has no answers or keys.

## 2026-11-04 — M10 test authoring and assignment

Made without the user (the task ran unattended); please review. The learner side is M11.

**Migration.** `20261101010000000_add-test-authoring.js` adds `tests.course_id` (required, indexed) and the five permissions. A migration was needed because `tests` had no link to a course, while a test must belong to a course and teacher scope comes from `course_teachers` of that course. `test_assignments.course_id` cannot replace it: it is one of four exclusive audiences. No API has ever written `tests`, so the `NOT NULL` needs no backfill; on a database that already has rows the migration stops without changing anything. Two fixtures that inserted raw `tests` rows were updated.

Deviations from the requested defaults, all because of the schema:

1. **No translations.** `tests` has no translations column. Only `title`.
2. **No module or lesson link.** The column does not exist, and this is not worth a migration without a rule that needs it. The audience columns `course_id` and `lesson_id` of `test_assignments` stay unused by the API.
3. **No per-assignment overrides** of time limit or attempts: `test_assignments` has no columns for them.
4. **No snapshot columns.** `test_questions` is the reference, and nothing more is needed: triggers already make published questions, their options, matching items, keys, assets and topics immutable, block their deletion, and block a return to draft. Archiving a question changes only its status, and it stays in published tests. Grading snapshots per attempt are `attempt_questions.grading_snapshot` (M11).
5. **No settings can change on a published test.** The `guard_test` trigger allows only a status change. So a published test can only be archived or copied, and `PATCH` returns `409 TEST_IMMUTABLE`.
6. **Show-results policy** maps to `answer_reveal_policy`: `after_submission`, `after_window`, `never`. The value `after_answer` exists in the schema but is not accepted, because it was not requested.
7. **Assignment `DELETE` revokes** (`status = 'revoked'`) instead of deleting, so M11 attempts keep their assignment. The row stays in the list.

Mapping and additions:

- Time limit is `timeLimitMinutes` (1 to 1440) stored as `duration_seconds`.
- `maxAttempts` defaults to 1 in the service, because the column has no default; explicit `null` means unlimited.
- `passPercent` is stored in `grading_policy`. Its meaning in grading is for M11.
- `mode` is required by the schema: `lesson`, `practice` (default) or `exam`. `exam` needs a time limit (database CHECK). `nct` is refused because the NCT rules are an open product decision.
- `resultPolicy` (`first`, default, `best`, `last`) is stored as the schema offers it; M11 applies it.
- Points are `NUMERIC(10,2)`, so they are decimal strings in responses. Requests accept a number or a string, above 0, at most 9999.99, at most 2 decimals.
- `counts_for_group_ranking` stays false: the ranking formula is not approved.
- **Teacher scope is the same for read, manage and assign:** the `teacher` role plus `course_teachers.can_manage_tests`. Outside it the test returns `404 TEST_NOT_FOUND` and the course `404 COURSE_NOT_FOUND`. `tests.publish` is owner/admin only; a teacher gets `403 ACTION_FORBIDDEN`.
- **`tests.results.read` is seeded but no endpoint uses it yet**: results need attempts (M11). Its scope (`can_view_results`) is applied there.
- **Extra rule, not requested:** a teacher can assign only to a group where `group_teachers.can_assign_tests` is true; otherwise `404 GROUP_NOT_FOUND`. The flag exists for this, and without the rule a teacher could reach any group.
- **Question eligibility:** published, verified key, and in a bank the actor can read (same rule as M08). An unreadable question returns `404 QUESTION_NOT_FOUND`. The subject of the question is not compared with the subject of the course.
- **Individual assignment** needs an active user with an enrollment in the test's course that is not revoked or expired (`409 STUDENT_NOT_ENROLLED`). A scheduled enrollment counts, because the assignment may open later.
- **Group assignment** does not check members. Groups grant nothing, so M11 must check each student at start.
- **Assignment rules:** the test must be published; the group must be active; one active assignment per test and audience (`409 ASSIGNMENT_DUPLICATE`, serialized by the test row lock); `closesAt` must be later than `opensAt` and in the future on create; `after_window` tests need a `closesAt`, otherwise results would never open.
- Archiving a test leaves its assignments as they are. M11 must refuse a start on a test that is not published.
- Deleting a draft that has copies returns `409 TEST_HAS_COPIES`: `copied_from_id` is `ON DELETE RESTRICT`.
- Questions are added by hand. Selection by parameters (`generation_filters`), listed in the roadmap, was not requested here and is not built.

Open for M11:

- Tests have no module, so "module grant" at start has no defined target. Options: require any current module grant in the course, or add a nullable `tests.module_id`.

## 2026-11-01 — Re-enrollment and enrollment candidate filter

- `POST` on a revoked enrollment or module grant reinstates the existing row (behaviour already present since M06); this slice adds explicit coverage and docs. The audit codes stay `course.enrollment.regranted` / `course.module_access.regranted` instead of a new `enrollment.reinstated` code, to keep audit history under one code. Module grants are never restored by an enrollment reinstatement.
- `GET /admin/courses/:courseId/enrollments` items expose `user.phone` with the same primary-phone selection and no masking as `GET /admin/users` (both are admin-only).
- `GET /admin/users?notEnrolledInCourse=:courseId` excludes only non-revoked enrollments (active, scheduled, expired). Expired enrollees are excluded because a new `POST` would return `409`; they are renewed with `PATCH`. A nonexistent course id simply excludes nobody.

## 2026-10-31 — Optional group codes and archived groups

1. **`code` is optional on `POST /admin/groups`.** When omitted, the server generates `<slug>-<6 hex>` from the name (Russian/Tajik Cyrillic transliterated to latin, `a-z0-9` and hyphens, at most 80 characters, `group` when the name has no usable characters). The insert uses `ON CONFLICT (code) DO NOTHING`, so a collision retries with a new suffix inside the same transaction (up to 5 attempts) and never surfaces `GROUP_CODE_CONFLICT`. Explicit codes keep the existing validation and `409 GROUP_CODE_CONFLICT`. The column and its unique constraint are unchanged; no migration.
2. **Archived groups (proposed, pending product confirmation).** Adding, editing or removing members and teachers and creating announcements in an archived group return `409 GROUP_ARCHIVED`. Reading stays allowed, `PATCH status=active` restores the group, and existing announcements may still be edited or archived. Editing the representative flag and teacher permissions is treated as a composition change and is also blocked.
3. **Announcement `status` filter.** Without `status` the feed is unchanged. With `status`, drafts and archived items are returned only to owners/admins and teachers whose assignment has `can_publish_announcements`; everyone else (students, teachers without publishing) receives published items only, i.e. an empty list for `draft`/`archived`, instead of an error.

## 2026-10-31 — Owner role is created only by bootstrap:owner

`PUT /admin/users/:userId/roles` never grants `owner`, not even when an owner is the actor (`403 ROLE_ASSIGNMENT_FORBIDDEN`, an existing code). "Granting" means adding a role the target does not hold; keeping `owner` in the set of an existing owner is allowed. New owners come only from `npm run bootstrap:owner`. Owners still grant `admin`, `teacher` and `student`; admin limits are unchanged.

Open: an owner may still remove `owner` from another owner (subject to `LAST_OWNER_PROTECTED`). Combined with this rule, a removed owner cannot be restored through the API. Kept as-is pending a product decision.

## 2026-10-31 — Admin accounts slice (M17)

Assumptions made without the user (please review):

1. **No migration and no new permission.**
   - The list reuses `accounts.pending.read`, as requested.
   - Role replacement is gated by the existing `accounts.approve` permission (owner, admin), and the service enforces the owner/admin rules on top.
   - A dedicated `accounts.roles.manage` permission can be seeded later if teachers or other roles ever need it.
2. **`student` is mandatory in every role set** (`422 STUDENT_ROLE_REQUIRED`).
   - The schema has no constraint here, but registration assigns `student` to every account; this keeps that invariant.
   - Accounts created outside registration (for example fixtures) must gain `student` the first time their roles are edited.
3. **Admins cannot edit accounts that hold `owner` or `admin`**, even for teacher/student only. "Admin manages teacher/student only" is read as deny-by-default.
4. **Owner protection uses one global advisory lock** (the existing `everest.owner-bootstrap` key) for role changes, block/reject/unblock and owner bootstrap. The owner set is therefore checked serially: two owners demoting each other at the same time cannot both succeed.
5. **"Last active owner"** counts owners whose account status is `active`.
   - Through the API, the actor is itself an active owner, so this case can only arise through a race or an inactive actor. The check is a defensive guard and is tested at the service level.
   - Blocked owners may still lose `owner` (an owner actor is required).
6. **Session revocation on role change.** Permissions are read from the database on every request, so a role change takes effect immediately even without revocation. As requested, the subject's live sessions and refresh tokens are still revoked (reason `roles_changed`), so clients re-authenticate with fresh state. Block keeps the M02D behaviour (`account_blocked`), now covered by a test.
7. **Unchanged role sets are a no-op** (`changed: false`): no audit row and no revocation.
8. **Search** has no index (no trigram extension).
   - It is bounded by a 2–100 character input, literal LIKE wildcards and `limit` ≤ 100.
   - `total` is a separate `count(*)` with the same filter.
   - Acceptable for the expected account volume; revisit with `pg_trgm` if accounts reach six figures.
9. **List item fields:** `id, firstName, lastName, displayName, phone, status, roles, createdAt, lastLoginAt, telegramLinked`. `lastLoginAt` was added beyond the request because the admin UI benefits from it. `approve` is not owner-protected: a pending owner can only exist through manual data.

## 2026-10-31 — Indexed book import (M09)

User decisions (from the M09 brief):

- CLI first: `npm run import:questions`. There is no HTTP package upload in M09.
- Runs are recorded in `question_imports`/`question_import_errors`; the same key with the same hash replays, and the same key with another hash conflicts.
- Dry run and real run share one validation path. A dry run writes nothing.
- Imports create drafts only. They never publish, never guess answers and never verify keys. A package key is at most `proposed`.
- `external_id` is required for imported questions.
- Re-import updates drafts in place. Published and archived questions are skipped with `QUESTION_IMMUTABLE_SKIPPED`, never copied or changed. Taxonomy upserts never delete anything.
- Images are deduplicated by sha256, and `asset_aliases` resolves package-local IDs.
- Duplicate detection is a conservative suggestion only.
- Do not fix in M09: per-question translations, inline markup, table headers/merged cells, grading tolerances, a `ready` status, book page tables.
- Read-only run API with `questions.manage`/`questions.review`.

Follow-up (2026-10-31, real packages `everest-tajik-indexed-v1.zip` and `everest-biology-tg-2026-pilot.zip`). Assumptions made without the user (please review):

- **F1. The real relational format replaces the invented one.** `manifest.json` + `data/<entity>[.partNNN].json` envelopes are read by `utils/question-package-adapter.js` and converted to the internal nested model, which is still accepted for tests and hand-written packages (contract §9.9). Nothing subject-specific is hard-coded.
- **F2. Not silently dropped.**
   - Fields without a column are reported once per entity and field (`SOURCE_FIELD_DROPPED`): bbox, sourceSpans, positions, topic metadata, `difficultyReason`, question `sectionCode`, topic-link classification, and several bank provenance fields.
   - Lossy content mappings are reported once per question and code: inline marks are reduced to the shared marks, `line_group` becomes `verse`, matching `columnHeaders` become a one-row table, inline formulas are split.
   - The package itself remains the full record.
- **F3. `open` questions** with `answerFormat: short_text|numeric` become that type. Their input-cell settings are reported, not stored (M10/M11 grading).
- **F4. `source_metadata` allowlist** = the provenance fields the packages really use: `year` (also from `examYear`), `sourceFile`, `printedPage`, `sequence`, `bookSectionTitle`, `bookRubric`, `isSample`, `reviewRequired`, `examPart`. `page` comes from `page`, then a numeric `printedPage`, then `pageIndex1Based`; `number` comes from `number`, then `sourceNumber`.
- **F5. Unstated matching rules stay `null`.** Both packages use `allowRightReuse: null`. The M08 parser now accepts `null` in drafts. Keys are validated strictly (no reuse; all-left not required), and publication is refused (`INTERACTION_SETTINGS_INCOMPLETE`). The DB trigger already required booleans only at publication, so no migration was needed. The importer never guesses `false`.
- **F6. `question_assets` links without an image block** (biology) become image blocks appended to the question content (`IMAGE_BLOCK_APPENDED`), because EVEREST derives `question_assets` from blocks.
- **F7. Asset provenance** (`extractionMethod`, page, bbox, `embeddedSha256`, …) is kept in `assets.source_metadata.package` (≤16 KiB), which is not exposed to students. Declared `sizeBytes` must match the bytes; declared dimensions are compared with the PNG header (warning only).
- **F8. Declared duplicate links** are imported with the package `reason` and `marked_by` = actor. They are counted separately (`duplicates.declared`) from the importer's own exact-match suggestions.
- **F9. `readyForImport: false`** (biology pilot) is a warning, not a block, because a draft-only import is the review step. **More than one bank** per package is rejected.
- **F10. Test isolation.** `npm test` (`test:auth`) now runs the node:test suite in a freshly migrated disposable database (`scripts/test-disposable-database.js`, the same approach as `test-migration-cycle.js`). The developer database is never read or changed by the suite. This also exposed a latent bug in `password-auth.test.js`: an audit join was not scoped by `entity_type` and passed only because the identity sequences in `everest_db` had drifted apart.

Original assumptions:

1. **Package format.** No package schema existed in the repository, and no sample package was available (`import-packages/` is absent). The implemented format is the camelCase proposal in `docs/import-contract.md` §7, fixed in §9, with three concrete choices:
   - image blocks use `{ "type": "image", "asset": "<package id>" }`, and a raw DB `assetId` is rejected;
   - option and item labels are `label`;
   - a package is a directory or a ZIP with `manifest.json` at the root (or inside one top-level folder).
   A real Tajik/biology package may need a field mapping. Run a dry run first.
2. **One bank per package.** `question_imports.bank_id` is NOT NULL, so a run belongs to one bank. A book with several banks is several packages.
3. **Batches of up to 100 questions** (default 100, `--batch-size 1..100`), each in its own transaction. The **first failing batch stops the run**: it is rolled back and recorded with a single `IMPORT_BATCH_FAILED` (or AppError code) entry covering `questions[a..b]`. Later batches are counted as `notAttempted`, and the run ends as `failed`. Committed batches stay, and a re-run with a new key is idempotent through natural keys. The alternative, continuing after a failure, was rejected because it can cascade errors and makes the run state harder to reason about.
4. **Validation errors write nothing.** A real run whose planner finds any error returns `status: rejected` and records **no** run (exit code 2). Only runs that pass validation are recorded; a run row always has an existing bank, as the NOT NULL `bank_id` requires.
5. **Default idempotency key** = `package-<sha256>`. Re-running the same package without `--idempotency-key` replays the earlier result. To re-import after a failure or a published-question change, pass a new key. Allowed keys match `[A-Za-z0-9._:-]{1,200}`.
6. **A replayed run must be visible to the actor** (bank owner or administrator), otherwise `QUESTION_BANK_READ_ONLY`. A replay of a `failed` run returns that failed result. It does not resume the run.
7. **Taxonomy permissions.** Creating a missing subject, section or topic needs `taxonomy.manage` (teachers do not have it): `TAXONOMY_PERMISSION_REQUIRED`. Translation changes on existing entities are applied only with `taxonomy.manage`, otherwise they are skipped with a warning. Stored structure (primary language, color, section, parent) is never changed by an import (`TAXONOMY_FIELD_MISMATCH` warning). No ordering, description or external-ID columns were added: codes are the keys.
8. **An existing bank is never modified** by an import (title and visibility stay; `BANK_FIELD_MISMATCH` warning). Its subject must match.
9. **Answer key on re-import.** A `proposed` package key replaces the stored key. An `unknown` package key keeps any stored key: an import never erases an answer an author or reviewer entered. The stored explanation is kept in that case too. A verified key on an edited draft returns to `proposed` (the M08 reconcile rule).
10. **Images: bank-bound upload path = the importer service, not an HTTP endpoint.** Imported images are stored by `storage.uploadObject` (new `PutObject` method on the S3 adapter and the memory double) under the content-addressed key `question-imports/sha256/<hash>.png|jpg`. They are inserted as `ready` `material` assets with `processing_status = not_required`, `uploaded_by` = actor and `source_metadata = { importNamespace, bankId }`. They are not linked to a course.
   - Checks: PNG/JPEG only, magic bytes via the M07-A `inspectMedia`, 10 MiB per image, optional declared sha256 verified.
   - An HTTP bank-bound upload endpoint for the admin UI is deferred.
   - Objects are uploaded before the DB transaction. This is idempotent because the key is the hash; a failed transaction leaves at most an unreferenced object.
11. **Asset reuse across users.** An asset found by sha256 or by alias is reused even when another user uploaded it: presenting identical bytes proves possession of the content. Package images bypass `findUsableImageAssets` only because they can only be referenced through the package's own `assets[]`. The M08 rule still applies to every later API edit.
12. **Migration** `20261031030000000_add-question-import-support.js` (reversible):
   - a partial unique index `assets_sha256_key` on `assets (sha256) WHERE sha256 IS NOT NULL`, for race-safe content dedup. `sha256` was never filled before, so the index cannot conflict with existing rows;
   - an index `question_import_errors (import_id, id)` for paginated reports.
13. **`source_metadata` allowlist** (superseded by follow-up assumption F4 below): the first version added `chapter`, `variant` and `year` without a real package; `chapter` and `variant` were removed again because the real packages do not use them.
14. **Duplicate signature.** Same bank + same type + equal normalized content text (NFKC, lower case, whitespace collapsed; formulas, tables and images included by value) + equal unordered set of normalized option/matching texts. The new question links to the earliest matching question (`reason = 'import: same normalized text and options'`). A link in either direction prevents a second one. Note: a linked draft cannot be deleted through the API (`QUESTION_IN_USE`), and no API exists yet to remove links.
15. **Errors are per question, first error only**, the same as the M08 API. Messages contain codes, field names and identifiers (topic codes, asset IDs), never question text or answers. Plain database errors in a batch are reported as `database error <sqlstate>` without the driver message.
16. **Run scope for the read API:** administrators see all runs; others see runs of banks they own and runs they started. Out-of-scope runs return `404`. Dry runs are not stored, so they never appear in the API.
17. **Run status values used:** `importing` → `completed` | `failed`. `pending`, `validating` and `validated` (in the schema CHECK) are unused, and `is_dry_run` is always `false` for stored runs.
18. **Limits:** 512 MiB per package, 64 MiB per entry, 20,000 questions and 20,000 assets per package. These limits are not tuned against a real book.

## 2026-10-30 — OpenAPI 3.1 and Swagger UI (M-DOCS)

User decisions:

- Swagger UI is served at `/api/docs` and the JSON at `/api/docs/openapi.json`.
- In production it is off by default and enabled with `SWAGGER_ENABLED=true`. In development it is on by default.
- The supported sign-in flow is cookie login from Swagger. CSRF works through `X-CSRF-Token` + `Origin`.

Assumptions made without the user (please review):

1. **The spec is a JavaScript module** (`src/docs/openapi.js`), not hand-written YAML.
   - One `operation()` builder derives path parameters, security, the CSRF header, rate-limit and error responses from flags.
   - Repeated shapes are shared components, so ~133 operations are not duplicated by hand.
   - Paths are kept in Express syntax so the coverage test compares them directly.
2. **`swagger-ui-dist` 5.33.1 (exact pin), not `swagger-ui-express`.**
   - It is static files only, with no Express wrapper or extra transitive code.
   - A small controller serves an allowlist of three files (CSS, bundle, favicon) plus our own page and initializer. The package's demo `index.html`/petstore initializer is never exposed.
   - 5.33.1 was chosen because the newest release (5.34.0) was under two weeks old.
3. **`@seriousme/openapi-schema-validator` 2.11.0 (devDependency, exact pin)** validates against the official OpenAPI 3.1 JSON Schema. It is small (ajv-based) and supports 3.1 strictly.
4. **Drift protection** in `tests/unit/openapi.test.js`:
   - The spec is valid 3.1.
   - Registered Express routes and documented routes must match **both ways**.
   - Every documented error code must exist in `src/` (taxonomy codes built from a template are allowlisted).
   - Every authenticated mutation documents `X-CSRF-Token`.
   - `routes/index.js` exports `routeMounts` because Express 5 layers do not keep mount paths; the router and the test share that one table.
5. **Docs page hardening:**
   - Strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, no inline scripts); the initializer is a separate same-origin script.
   - `nosniff` and `no-referrer`; `persistAuthorization: false`.
   - The page copies the readable `everest_csrf` cookie into `X-CSRF-Token` only for mutations on the same origin.
   - CORS, CSRF and rate limits are unchanged: docs routes are read-only GETs outside `/api/v1`.
6. **A disabled Swagger returns the generic `404 ROUTE_NOT_FOUND`**, so production does not reveal that docs exist.
7. **Bearer is documented, but login never returns tokens in JSON.** Bearer stays for non-browser clients; the browser flow is cookie-based. No real token appears in examples.
8. **`scripts/bootstrap-owner.js` was broken.** It imported a removed `accountAdminService` object (SyntaxError at start).
   - It now imports `bootstrapOwnerService`; there is no other change.
   - A unit test guards the import. The script was not run against `everest_db` because it would assign an owner.
9. **Repair:** M07-C had accidentally duplicated the top of `docs/api.md`, because a `$\`` sequence was interpreted by `String.replace`. It is repaired here. Doc edits now avoid `String.replace` with literal text.

## 2026-10-30 — Learner catalog enrichment (M07-C)

User decisions:

- `subjects.color` is a fixed palette key `green|blue|orange|purple|neutral` (CHECK constraint, default `neutral`), not hex. It is managed through the M08 subject API.
- Learner cards carry `subject { id, title, translations, color }`, `moduleCount` and `lessonCount`.
- No `testCount` until M10 and no slugs.
- `GET /profile` gains `telegramLinked`.

Assumptions made without the user (please review):

1. Counts cover published lessons in published modules, including modules the learner has not been granted. M07-B already shows locked module and lesson titles, so the count discloses nothing new. The old "locked modules expose no counts" note now means per-module counts only.
2. `subject` is `null` for a course without a subject (draft courses can have none; published courses require one since M05-A, so this covers legacy rows only).
3. `telegramLinked` is a boolean derived from `auth_identities`. No Telegram ID, username or profile data is returned.
4. The favorites list (`GET /courses/favorites`) is unchanged; it was not requested.

## 2026-10-30 — Taxonomy and question bank (M08)

User decisions: the milestone order is M08, then M07-C (learner catalog enrichment); M08 follows ROADMAP exactly.

The baseline schema already had every M08 table and trigger, so M08 adds APIs, validation and permissions. Migration `20261031010000000_add-question-bank-permissions.js` adds the five permissions and one CHECK constraint, and no tables.

### Assumptions made without the user (deny-by-default; please review)

1. **Permissions:**
   - `taxonomy.read` (owner, admin, teacher) and `taxonomy.manage` (owner, admin).
   - `questions.read` and `questions.manage` (owner, admin, teacher).
   - `questions.review` (owner, admin).
   - Students get none. Taxonomy is staff-only until M07-C exposes subjects in the learner catalog.
2. **Bank scope:**
   - Banks are not tied to courses, so `course_teachers.can_manage_questions` is not used yet (it becomes relevant with tests in M10).
   - Readable: administrators, the bank owner, and every staff member when `visibility = 'staff'`. Manageable: administrators and the owner only.
   - An unreadable bank returns `404`, never `403`.
   - `subjectId` of a bank is immutable, because questions reference `(bank_id, subject_id)`.
3. **Key confidentiality among staff:** `answerKey` (answer data and explanation) is returned only to actors who can manage the bank. Read-only staff see `keyStatus`. Audit metadata never contains answer data.
4. **`answer_data` references item keys, not row IDs.** This keeps keys valid across copies and item replacement. Formats per type are in `docs/api.md`. Numeric tolerance, short-text normalization and partial credit are grading policy and are deferred to M10/M11: a numeric key is one exact `value`.
5. **Verification:**
   - Only `questions.review` can verify, and only a `proposed` key.
   - The reviewer must attest `official_key` or `expert_review`. A new CHECK constraint makes `verified` + `ai_inference`/`none` impossible in the database too.
   - An administrator may verify a key they authored themselves. A four-eyes rule would block a small center; `verified_by` records who verified.
6. **Edits invalidate review:** any draft `PATCH` returns a `verified` key to `proposed`. If the edit removes items the key references, the key is reset to `unknown` (the explanation is kept) instead of the edit being blocked.
7. **Publication** (`questions.review`) requires a verified key that still validates against the current items, and every embedded asset still ready.
   - Topics are not required for publication; ROADMAP does not require them.
   - Archive is one-way (`published → archived`). Corrections use `copy`, which creates a draft with `source_question_id`. A copied key must be verified again.
8. **Deletion:** only drafts can be deleted, and only when no copy, test question or duplicate link references them. Taxonomy deletion relies on `RESTRICT` foreign keys and returns `*_IN_USE`.
9. **Rich question content** is a closed set of blocks: `text` with marks, `verse`, `formula` (LaTeX), `chemistry`, `table` and `image`.
   - Every block is rebuilt from an allowlist, so unknown properties are dropped by rejection, not stored.
   - Limits: 100 blocks and 64 KB per content value.
   - This differs from lesson blocks on purpose: question content needs formulas, chemistry, verse lines and images (documentation.md §13).
10. **Question images:** the image must be a ready PNG/JPEG that the author uploaded, that is already used in the same bank, or, for administrators, any such image.
   - Uploads are still course-bound (M07-A). A bank-bound upload path is left to M09, where book pages and assets are imported.
   - `question_assets` is recomputed from all content (question, items, explanation) on every write.
11. **Taxonomy:**
   - Titles live only in `*_translations`, and the primary-language title is mandatory.
   - Topic re-parenting locks the subject's topic rows and walks the ancestor chain in the same transaction (baseline note 18), so concurrent edits cannot create a cycle.
   - A section and a parent must belong to the same subject (`422 TAXONOMY_SUBJECT_MISMATCH`).
12. **Imports and duplicates:** imports, dry runs and duplicate detection stay in M09. `question_imports`, `question_import_errors` and `question_duplicate_links` have no API in M08.

## 2026-10-29 — Lessons, playback and offline licenses (M07-B)

### Seek-ready video policy (supersedes the M07-A remux decision)

User decision. It replaces M07-A items 5 and 7 and the "remux job" bullet below for every new upload:

- Only seek-ready video is accepted:
   - MP4 must have `moov` before `mdat` (fast start).
   - WebM must contain `Cues` before the first cluster.
   - QuickTime (`.mov` / `video/quicktime`) is refused at initiation (`400`). Content with the `qt  ` brand is rejected at completion.
- A non-seek-ready file is rejected with `422 VIDEO_NOT_SEEKABLE`. The message is "Export as MP4 with fast start (web optimized)"; for WebM it is "Export as WebM with cues at the start, or as MP4 with fast start (web optimized)". The object is deleted, and the asset is quarantined with `processing_error = 'VIDEO_NOT_SEEKABLE'`.
- No `asset.video.remux` jobs are created, and `background-job-repository` was removed because nothing uses it. The asset columns stay. New video assets get `processing_status = 'not_required'`; materials keep `'none'`.
- Playback requires `status = 'ready'` **and** `processing_status = 'not_required'`. Anything else returns `409 VIDEO_NOT_PLAYABLE`.
- Staff fix files before upload with `npm run video:faststart -- input [output.mp4]`. It wraps `ffmpeg -c copy -movflags +faststart` (no re-encode) and prints a clear error when ffmpeg is missing. The API server has no ffmpeg dependency.

### Assumptions made without the user (deny-by-default; please review)

1. Video assets uploaded under M07-A keep `processing_status = 'none'`, so they are not playable. The migration does not reclassify them: WebM Cues were never checked for those uploads. Only pre-production test data was affected.
2. **Superseded on 2026-10-29 (user decision): published lessons are edited directly.** Teachers and administrators should not have to understand statuses, so the earlier "draft-only editing" rule (`LESSON_NOT_EDITABLE`, archive → restore → edit → publish) was removed.
   - `PATCH`, chapters and resources work in draft, published and archived status, with the same `lessons.manage`/`canManageLessons` scope.
   - A published lesson must stay publishable. It cannot become `test` (`LESSON_TYPE_NOT_PUBLISHABLE`) or lose the video of a `video`/`mixed` lesson (`LESSON_VIDEO_REQUIRED`). A new video must be ready, seek-ready and from the same course.
   - Replacing the video is refused, with nothing changed, when existing chapters would start at or after the new video's end (`409 CHAPTERS_EXCEED_VIDEO_DURATION`, which replaces the earlier undocumented `CHAPTERS_OUT_OF_RANGE`).
   - Replacing the video revokes the lesson's active offline licenses for the old video in the same transaction (`access_lost`). The next download check reports the existing reason `video_unavailable`. Learner progress is not reset.
   - There are no version history, revision drafts or new tables. The existing audit events stay; `lesson.updated` also records `previousVideoAssetId` and `revokedLicenses` when the video changes.
   - Deletion is still allowed only for empty drafts. Ordering is allowed in every status.
3. Publication rules:
   - A `video` lesson needs a playable video (`LESSON_VIDEO_REQUIRED` / `VIDEO_NOT_PLAYABLE`).
   - `test` lessons could not be published until tests existed (superseded on 2026-11-05: see the lesson-test link decision; `LESSON_TYPE_NOT_PUBLISHABLE` is gone).
   - Only `video` and `mixed` lessons may have a video.
   - A lesson can be published inside a draft module, but learners see it only when the course, module and lesson are all published.
4. Content blocks are a closed set of plain-text types: `heading` (`level` 1–3), `paragraph`, `list` (`items`, `ordered`), `quote`, `code` (`language`), `callout` (`tone` info/warning/success), `divider`. The limits are 200 blocks, 20,000 characters per text field and 256 KB of JSON. Blocks cannot contain HTML or asset references; images are materials.
5. Lesson and chapter translations allow only `title` (languages `tg`, `ru`, `en`).
6. "Same course" asset rule: an asset qualifies if it was uploaded for that course, or if the lesson already references it. This second case exists because course copies reference source assets and are never duplicated.
7. Chapters need a lesson video. They are given in strictly increasing `startSeconds`, which also sets their positions. There are at most 100, and each must start before the video duration when the duration is known. Changing the video is refused when existing chapters would fall beyond the new duration. Removing the video is refused while chapters exist.
8. Materials are replaced as a full ordered list (at most 50). Each must be a `ready` material asset; a video cannot be a material.
9. "Empty draft" for deletion means no video, chapters, materials, progress, notes, offline licenses, activity events or test assignments.
10. Staff scope:
    - Owner/admin have `lessons.read` and `lessons.manage` on every course.
    - Teachers have both permissions, limited in the repository: they read lessons of assigned courses and manage only with `can_manage_lessons` (this deliberately differs from modules, which use `can_edit_course`).
    - A read-only teacher who tries to author gets `404 COURSE_NOT_FOUND`, the same as a missing course.
    - Staff preview playback and material URLs come from `/admin/...` routes and work for every lesson status.
11. Learner reads:
    - A learner sees lesson metadata only with a non-revoked enrollment in a published course and a published module and lesson. Otherwise they get `404`.
    - Without module access, the lesson detail is metadata only: no content, chapters, materials, video or progress.
    - Content routes (playback, materials, notes, progress, offline) return `403 MODULE_ACCESS_DENIED` through `requireModuleAccessService`.
12. Notes are owner-only. Reading, writing and deleting a note all need current module access. Each user can have 500 notes per lesson, each up to 10,000 characters. `playbackSeconds` must not exceed the known video duration.
13. Progress:
    - Writes carry `revision`. A stale revision returns `409 PROGRESS_REVISION_CONFLICT` with the current revision.
    - `watchedSeconds` never decreases. Both values are clamped to the video duration.
    - Completion is automatic at `watchedSeconds ≥ ceil(0.9 × duration)` and is never undone. A video whose duration is unknown never auto-completes.
    - Lessons without a video accept only `{ revision, completed: true }`.
    - Reading progress also needs current access, but rows are never deleted on expiry or revocation.
14. Favorites: `PUT`/`DELETE /courses/:courseId/favorite` (idempotent) and `GET /courses/favorites`. Only courses the learner can see (non-revoked enrollment in a published course) can be favorited or listed. Favorites grant nothing. There are no lesson favorites.
15. Signed URL TTLs: playback 30 min (inline), materials 5 min (attachment), offline download 15 min (attachment). The playback response carries `expiresAt`; the client calls the same endpoint again before expiry, and every call re-checks access.
16. A presigned S3 URL necessarily contains the bucket and object path, signed for `S3_PUBLIC_ENDPOINT`. The API never returns `storageKey`, the bucket or `S3_ENDPOINT` as fields. Keys are opaque UUID paths.
17. Signed media issuance (playback, material and offline download) is rate-limited per user: scope `learner.media`, `PLAYBACK_RATE_LIMIT`, default 120 per `AUTH_RATE_WINDOW_SECONDS`. Only denials (`lesson.playback.denied`, `lesson.material.denied`) and offline license events are audited.
18. Offline licenses:
    - A license covers the lesson video only. Materials are downloaded online.
    - The lease is the shortest of 3 days, the enrollment expiry and the module grant expiry.
    - A device is a live (not revoked, not expired) session holding an active license. A learner can have at most 2 devices; a third device gets `409 OFFLINE_DEVICE_LIMIT`.
    - Listing, download and deletion work only from the session that holds the license. Signing a session out frees its device slot.
    - Renewal and download re-run every check. When access is lost, the license is revoked with `access_lost` and the API returns `403 OFFLINE_ACCESS_DENIED` with `details[0].reason` set to one of `module_access`, `offline_not_allowed`, `video_unavailable`, `lesson_unavailable`, `license_revoked` or `license_expired`.
    - A license revoked by an administrator cannot be renewed from the same session. A license the learner deleted can be renewed.
    - Administrators list a user's licenses and revoke one with `lessons.offline.manage` (owner/admin only).
19. Course copy also copies every lesson as a draft (archived ones included, matching modules), with its chapters and materials. Assets are referenced, not duplicated. Progress, notes, offline licenses and favorites are never copied.
20. `.env.example` is still not editable from this session. Add `PLAYBACK_RATE_LIMIT` by hand together with the M07-A variables.

## 2026-10-29 — Media storage and multipart uploads (M07-A)

User decisions (2026-10-29):

- Storage is S3-compatible behind the provider-neutral adapter `src/providers/storage/`. Only `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are used; no vendor API. Switching MinIO → Garage or SeaweedFS is an environment change only (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, credentials, `S3_FORCE_PATH_STYLE`). `S3_ENDPOINT` is the backend-to-storage address; `S3_PUBLIC_ENDPOINT` is the host signed into browser URLs, because the host is part of the signature.
- Production storage will be a separate HostBrr server (4 TB RAID-6, Nginx + S3-compatible server). The domain comes later; locally everything runs on localhost.
- Upload is allowed to owner/admin (`assets.upload`) and to course teachers with `canManageLessons` for their own course. Everyone else is denied.
- Limits: 20 GiB per file. Video: mp4, mov, webm. Materials: pdf, docx, pptx, jpg/jpeg, png. The real type is verified from the stored bytes at completion.
- No multi-quality video, no HLS, no `asset_variants`. Videos are delivered in the uploaded quality as one file through a short-lived signed URL with Range support (delivery itself is M07-B). Completion validates container and codecs. `mov` files and `mp4` files without faststart get one `asset.video.remux` background job: remux to MP4 with faststart, no re-encode. M19 handles that job later.

MinIO finding (checked 2026-10-29): MinIO Community Edition went into maintenance mode in December 2025, and its GitHub repository was archived in February 2026. The README says critical security fixes are evaluated case by case and points users to the commercial AIStor. Vulnerabilities disclosed against the final community release (for example CVE-2026-39414 and CVE-2026-34204) are reported as not backported. Official community container images have reportedly been withdrawn from anonymous pulls. Consequences:

- MinIO is used only for local development, bound to `127.0.0.1`. It is never used in production.
- `docker-compose.yml` pins `minio/minio:RELEASE.2025-09-07T16-13-09Z`, reported as the last official container image. `MINIO_IMAGE` can point to a pinned community rebuild if the pull is refused. This tag could not be pulled or verified because Docker is not installed.
- Garage or SeaweedFS is the recommended production server. The choice is left to deployment (M21).

Assumptions made without the user (deny-by-default; please review):

1. Every upload belongs to a course (`courseId` is required). Uploads to archived courses are refused (`409 COURSE_ARCHIVED`). Draft and published courses are allowed.
2. A teacher must hold the `teacher` role **and** a `course_teachers` row with `can_manage_lessons`. When a teacher has no right for the course, the API returns `403` before it checks whether the course exists, so the response does not reveal which courses exist.
3. An existing upload is visible to holders of `assets.manage` (owner/admin) and to its creator. The creator sees it only while they can still upload to that course. Everyone else gets `404 UPLOAD_NOT_FOUND`.
4. The declared MIME type must match the file extension, and the detected type must equal the declared type. For example, a QuickTime file declared as `video/mp4` is rejected. Matroska that is not WebM is rejected.
5. Allowed codecs: video H.264 (`avc1`/`avc3`), HEVC (`hvc1`/`hev1`), AV1 (`av01`) and VP9 (`vp09`) in mp4/mov. Audio AAC (`mp4a`) or Opus. WebM allows VP8, VP9 or AV1 video with Opus or Vorbis audio. At least one video track is required. Tracks other than video and audio are ignored. Inspection is a pure-JS structural parser (ffprobe-style metadata, no decoding). ffmpeg is not required on the API server.
6. A rejected upload is marked `rejected`, its asset becomes `quarantined` with the rejection code, and the stored object is deleted. Rejection is final; the user must start a new upload.
7. Assets are `ready` once validated. `processing_status = 'pending'` marks a remux still owed. M07-B playback must require `status = 'ready'`. It must decide explicitly whether a `pending` remux may play; the deny-by-default proposal is to wait.
8. Server-chosen part size: `STORAGE_PART_SIZE_BYTES` (default 32 MiB), raised in whole MiB when needed so that a file never exceeds 10,000 parts. The part-count check runs again at completion.
9. The upload session expires after `STORAGE_UPLOAD_TTL_HOURS` (default 144 h, maximum 166 h). That is always before the storage server's 7-day abort of incomplete uploads. Expired uploads cannot be presigned or completed; they can only be aborted.
10. Presigned part URLs live for `STORAGE_PRESIGN_TTL_SECONDS` (default 900 s). At most 100 parts can be requested at once.
11. The storage server's part list is the source of truth. The client never sends ETags, and completion verifies the number and size of every part. Completion locks the upload row, so concurrent and repeated calls return the same asset. If storage completed but the database transaction failed, the retry detects the assembled object with HEAD and finishes.
12. Abort is idempotent for `aborted` and `rejected` uploads. A `completed` upload cannot be aborted (`409`). An aborted upload's asset becomes `archived`.
13. The user's file name is stored only in `assets.file_name`, after removing path segments and control characters. Storage keys are `courses/<courseId>/<kind>s/<uuid>.<ext>` and are never returned by the API.
14. MinIO CE has no bucket CORS API, so CORS (including a readable `ETag`) is set server-wide with `MINIO_API_CORS_ALLOW_ORIGIN`. The 7-day cleanup is guaranteed by `MINIO_API_STALE_UPLOADS_EXPIRY=168h`. `npm run storage:configure` also applies a standard lifecycle rule and CORS rule wherever the server supports them (for production Garage or SeaweedFS).
15. Upload, complete and abort reuse the authenticated CSRF check and the administrative mutation rate limit. Part presigning uses CSRF but no rate limit, because a 20 GiB upload makes many presign calls.
16. `.env.example` could not be edited from this session (file access denied). The new variables are documented in `docs/architecture.md` and must be added to `.env.example` by hand.

## 2026-10-29 — Course enrollments and module access grants (M06)

The user was unavailable for M06, so every ambiguity below was settled with the safest, most restrictive option (deny by default) and recorded here. Each item is an assumption the user may overturn; none changes the confirmed rules (groups independent from courses, separate course and module grants, expiry/revocation never deletes progress, locked modules expose only safe published metadata).

1. **Who manages grants.** Two new permissions, `courses.access.read` and `courses.access.manage`, are granted to `owner` and `admin` only. Course teachers, even with `canEditCourse`, receive neither, so a teacher cannot widen a student's access. Both codes are seeded by the reversible migration `20261029010000000_add-course-access-permissions.js`.
2. **Who can be enrolled.** The grantee must be an `active` account holding the `student` role. Pending, rejected, blocked, teacher-only and admin accounts get `409 ENROLLMENT_USER_INELIGIBLE`. Completed onboarding is not required to be granted, but `can_access_module` requires it to read protected content, and the learner view reports `onboarding_required`.
3. **Course and module must be published to be granted.** Enrollment requires a `published` course (`409 COURSE_NOT_PUBLISHED`). A module grant requires a `published` module in that course (`409 MODULE_NOT_PUBLISHED`). Existing grants are untouched when a course or module is later unpublished or archived; `can_access_module` blocks access while it is not published, and access returns when it is published again.
4. **Explicit validity windows.** `expiresAt` is required on every grant and extension. An ISO 8601 timestamp with a UTC offset sets an expiry; an explicit `null` means no expiry, so unlimited access is a deliberate choice and never an omission. `expiresAt` must be in the future and after `beginsAt`, and no later than the year 2100. `beginsAt` defaults to the server clock and may be in the future (state `scheduled`). The database `CHECK (expires_at > begins_at)` remains the last guard.
5. **Grant states.** `state` is computed in PostgreSQL as `revoked`, `scheduled`, `expired` or `active`, in that precedence.
6. **Extension.** `PATCH` changes only `expiresAt`. It works on `active`, `scheduled` and `expired` rows, so an expired grant is renewed by extending it. It is refused with `409 ENROLLMENT_REVOKED` / `409 MODULE_ACCESS_REVOKED` for a revoked row; the administrator must grant again. An extension may also shorten or remove an expiry; a shortened date must still be in the future (use revoke to end access now).
7. **Revocation and re-grant.** Revocation sets `revoked_at`/`revoked_by` and never deletes a row. Revoking twice returns `409 ENROLLMENT_ALREADY_REVOKED` / `MODULE_ACCESS_ALREADY_REVOKED`. A `POST` on a revoked row resets it in place (new grantor, `granted_at`, window, cleared revocation) because `UNIQUE (user_id, course_id)` and `UNIQUE (user_id, module_id)` allow one row; history lives in `audit_events` (`...granted` versus `...regranted`). A `POST` on a non-revoked row, even an expired one, is `409 ENROLLMENT_ALREADY_EXISTS` / `MODULE_ACCESS_ALREADY_EXISTS`; extend it instead.
8. **Revoking an enrollment revokes its module grants.** In the same transaction, all unrevoked module grants of that user and course are revoked, and the count is audited as `revokedModuleGrants`. Re-granting the course therefore never silently restores module access; each module must be granted again. Expiry, in contrast, is passive: an expired enrollment leaves module grant rows untouched, and `can_access_module` denies content while the enrollment is not current. Extending the enrollment makes grants that are still inside their own window effective again.
9. **Module grants require a current enrollment.** A module grant needs an enrollment in state `active` or `scheduled` (`409 ENROLLMENT_NOT_ACTIVE` otherwise). Containment of the module window inside the enrollment window is not enforced, because effective access is the intersection, which `can_access_module` already computes.
10. **Progress is never touched.** No grant operation writes or deletes progress, notes or attempts. The tests assert a `lesson_progress` fixture row survives module expiry, enrollment expiry, revocation and re-grant.
11. **Locked-module learner DTO.** Learners see `{ id, position, title, description, translations, access: { granted, lockReason } }` for the `published` modules of a `published` course in which they hold a non-revoked enrollment. No lessons, assets, tests, counts, grant dates, grantor or revocation facts are included. `lockReason` is one of `onboarding_required`, `not_started`, `expired`, `not_granted`, `unavailable`. A revoked module grant reports `not_granted` so the reason never discloses administrative history. A revoked enrollment, an unenrolled user, an unpublished course and an unknown course are indistinguishable (`404 COURSE_NOT_FOUND`); an expired enrollment still shows the course, with every module locked, so the learner can see why.
12. **Single source of truth.** Whether content is granted comes from the existing database function `can_access_module` (active account, completed onboarding, published course and module, both grants current). The API adds the live-session check through `authMiddleware`. The reusable guard `requireModuleAccessService` calls that function and throws `403 MODULE_ACCESS_DENIED`; M07 must call it before returning any lesson, asset or test content. No lesson, asset or test route is added in M06.
13. **Teachers and administrators.** Teacher or administrator access to protected learner content is not defined by M06. They read grants only through the administrative API and are denied by the learner guard unless they also hold grants; M07 must decide authoring and preview access explicitly.
14. **Concurrency.** Grants lock in a fixed order: course `FOR SHARE` (blocks a concurrent unpublish), module `FOR SHARE`, user `FOR SHARE` (blocks a concurrent block/state change), then the enrollment and grant rows `FOR UPDATE`. Inserts use `ON CONFLICT DO NOTHING`, so two simultaneous grants yield one `201` and one `409`, never a `500`. Audit events are written in the same transaction as every change.
15. **Scope.** No `group_courses`, lessons, videos, progress, tests or AI code was added. The learner endpoints are limited to the learner's own courses and published module structure.

## 2026-10-28 — Course modules, preview and copying (M05-B)

User-approved rules:

- **Module lifecycle.** The only transitions are `draft → published → archived` and `archived → draft`. A module can be published in any course; student visibility is decided later by course status and M06 grants.
- **Deletion.** Only a `draft` module with no `lessons` rows can be deleted. Checking the existing `lessons` table keeps this rule correct after M07. Modules with lessons can only be archived.
- **Ordering.** A new module is appended at `max(position) + 1`. Archived modules keep their position, and deletion may leave gaps. Reordering takes the complete module-ID list and is validated for completeness, duplicates, and foreign IDs. Because `UNIQUE (course_id, position)` is not deferrable, reordering runs in one transaction in two passes: first shift every position above the current maximum, then assign `1..n`.
- **Preview.** Preview is read-only and available to owner/admin and any teacher assigned to the course. It shows structure and counts only: no progress, no locks, and no access grants.
- **Copying.** A copy is a `draft` course whose modules are all `draft`. Translations are copied. Teachers, enrollments, module grants, and progress are not copied. The whole copy runs in one transaction.

Two schema decisions also apply:

- **No course code.** `courses` has no `code` column, so the user chose a title-only copy. The default title is `<title> (copy)`, trimmed to 200 characters, and no schema change was made.
- **Who manages modules.** Module management follows the M05-A edit rule. `courses.modules.manage` is granted to owner/admin/teacher, and the repository scopes teachers to assignments with `can_edit_course`. `courses.copy` is owner/admin only.

The copy is built as an ordered list of copy steps in `course-module-service.js`. The modules step fills a source-to-copy module ID map so that M07 can add lesson, video, chapter, and material steps.

Implementation choice: the copy includes archived modules, as `draft` with their original positions, so the course structure and numbering stay identical.

## 2026-10-27 — Course catalog lifecycle and explicit teacher editing

M05 is split into M05-A catalog/lifecycle/teacher assignments and M05-B modules/order/preview/copying. M05-A exposes only the existing course catalog columns and uses dedicated publish/unpublish commands instead of accepting `status` through general PATCH. Publication requires title and subject; the schema's `archived` state remains documented but has no M05-A route.

The baseline `course_teachers` flags describe downstream lesson, question, test, and result capabilities but do not explicitly authorize editing course metadata. Migration `20261027020000000_add-course-management-permissions.js` therefore adds `can_edit_course BOOLEAN NOT NULL DEFAULT FALSE` plus five action permissions. Teachers receive only `courses.read` and `courses.update`; an assignment scopes reads, and `can_edit_course` independently scopes updates. Publication and teacher management remain owner/admin-only. Assignment removal is destructive because the published table has no lifecycle/history columns; a later assignment is a new row.

## 2026-10-27 — Group administration and text announcements

M04-B adds five database-backed actions: `groups.create`, `groups.update`, `groups.members.manage`, `groups.teachers.manage`, and `groups.announcements.manage`. Owner/admin roles receive all five. Teachers receive only announcement management, and the service additionally requires a current target-group assignment with `can_publish_announcements`; a global role grant alone never authorizes another group's resource.

Student membership removal changes the existing membership status to `removed` and records `left_at`; re-adding reactivates that same unique row. The published teacher-assignment schema has no lifecycle status/history columns, so removal deletes only that assignment. Announcement deletion archives the existing row. Announcement content is text encoded in the existing JSONB block shape; assets remain excluded until M07. Every successful mutation and its audit event share one transaction, and group relationships never create course or module grants.

## 2026-10-26 — Relationship-scoped group reads

M04-A uses current database state for every group read. An active `group_members` row grants that student visibility; a `group_teachers` assignment grants that teacher visibility; current `owner` and `admin` role assignments grant administrative read visibility. No permission-management API or new permission seed is needed for the read-only increment. Missing and inaccessible group IDs intentionally share `404 GROUP_NOT_FOUND` to prevent resource enumeration.

Member counts and rosters include only active memberships. Teacher assignments have no status column, so every existing assignment is current. Roster queries combine access and pagination in one SQL statement to avoid a revocation race. Groups remain organizational only and never create course enrollments or module grants.

## 2026-10-26 — Schema-driven profile onboarding

M03 reuses `users`, `user_profiles`, `user_phones`, `user_roles`, `roles`, and the existing avatar asset FK without a migration. The current schema has no student/teacher profile extension, grade/class, educational direction, learning goal, or display-name column. Those fields are not invented; `displayName` is derived from first and last name, and the avatar asset ID remains read-only until an authorized upload flow exists.

Onboarding requires only non-null `firstName` and `lastName`, matching the baseline's explicit service-level requirement. Completion never changes account status and is allowed only for an active account. The frontend language contract uses `ru`, `tj`, and `en`; API `tj` is translated to the existing database constraint value `tg` so the published baseline remains unchanged.

## 2026-10-26 — Persistent authentication throttles and session-bound CSRF

M02F-B uses one PostgreSQL `auth_security_counters` table for process-independent atomic fixed-window counters. Counter keys are HMAC-SHA-256 values derived from server configuration; plaintext account identifiers and credentials are never stored. Public authentication and administrator mutation routes have IP/action limits, while password login also uses a normalized-phone account counter with five attempts and a 15-minute lockout. Successful login removes that account counter. Stable limit responses are `429 AUTH_RATE_LIMITED` plus `Retry-After`.

Cookie-authenticated mutations use a random 32-byte CSRF token created with the session. Only its SHA-256 hash is stored on `auth_sessions`; the browser receives the token in a readable `everest_csrf` cookie and echoes it in `X-CSRF-Token`. The server also requires an exact configured CORS origin. The token remains stable through refresh rotation because the PostgreSQL session is the security boundary and is invalidated when that session is revoked or expires. Bearer requests and genuinely public authentication/recovery endpoints are exempt.

## 2026-10-26 — Database-backed action permissions

M02F-A adds `permissions` and `role_permissions` as the reusable RBAC foundation. Runtime authorization resolves current database assignments on every protected request through repository-owned SQL; permissions are not embedded in JWTs, so assignment changes take effect without waiting for token expiry. Middleware selects the required action, the service makes the authorization decision, and repositories only answer persistence questions.

Only already-approved account-administration semantics are seeded: `accounts.pending.read`, `accounts.approve`, `accounts.reject`, `accounts.block`, and `accounts.unblock` belong to `owner` and `admin`. Existing routes, authentication ordering, `403 ADMIN_ROLE_REQUIRED`, business transactions, and audit behavior remain unchanged. No owner bypass or implicit role hierarchy exists, and no teacher/student or unresolved domain/resource permission is inferred. Permission-management APIs, rate limiting, brute-force controls, and CSRF remain outside M02F-A.

## 2026-10-25 — Password recovery proof and provider boundary

M02E returns a random opaque challenge identifier for every syntactically valid recovery request, including unknown and ineligible phones. Only its SHA-256 hash is stored for eligible delivery, so the public contract does not expose sequential IDs, account existence, Telegram linkage, throttling, or provider outcomes. Six-digit codes use cryptographic randomness and an HMAC-SHA-256 verifier keyed by `OTP_HMAC_SECRET`; defaults are a 10-minute expiry, five attempts, a 60-second resend cooldown, and five created challenges per account/channel/hour. Creating an eligible challenge invalidates every earlier active password-recovery challenge for that user.

Successful verification consumes the code and installs a separate opaque 32-byte reset authorization with only its SHA-256 hash and 10-minute expiry stored. PostgreSQL row locks serialize verification and reset. Password replacement, reset consumption, all-session/refresh revocation, and audit persistence share one transaction. Recovery is permitted for active, pending, and blocked password accounts but never changes status or roles; rejected accounts are ineligible.

Telegram delivery requires both a verified Telegram login identity and the existing active bot connection. SMS has a narrow provider interface and test double, but the production provider remains deliberately disabled because none is approved. Production SMS delivery is not claimed as implemented. The incremental migration adds Telegram challenge support plus public/reset hashes and reset expiry/consumption fields without changing the 13 published migrations.

## 2026-10-25 — Session lifecycle and refresh-token family

M02D keeps the access JWT at 15 minutes by default and adds a configurable 30-day refresh/session lifetime. Each PostgreSQL `auth_sessions` row is one refresh-token family. Refresh secrets are 32 random bytes encoded as base64url; only SHA-256 hashes are stored. Successful refresh locks the token, session, and user rows, marks the token used, inserts one replacement with the family's original expiry, updates `last_used_at`, and issues a new access JWT. Concurrent use permits at most one rotation.

Presenting a used or revoked refresh token is treated as reuse: the session and every family token are revoked and an audit event is committed before a stable unauthorized response. This also invalidates any descendant issued by a competing request. No replacement-link migration is needed because the session is the family boundary and retained token history provides replay evidence.

Browser authentication uses HttpOnly `everest_access` and `everest_refresh` cookies. The refresh cookie is restricted to `/api/v1/auth`; both cookies use `SameSite=Lax`, explicit expiry, no Domain attribute, and `Secure` in production. Logout clears cookies with matching attributes. SameSite and restricted CORS reduce exposure but do not constitute complete CSRF protection; explicit CSRF/origin hardening remains M02F.

Sessions retain the bounded login User-Agent already captured by the shared issuer and the direct request IP selected by Express without trusting forwarded headers. APIs expose only coarse browser/OS/device labels and no IP. `last_used_at` updates on every successful refresh and at most once per 60 seconds during access authentication.

## 2026-10-25 — Cross-platform migration-source verification

The exact migration-source integrity comparison normalizes only CRLF or CR line endings to LF before comparing and hashing SQL. Indentation, blank lines, tokens, comments, capitalization, and statement order remain exact. Root `.gitattributes` enforces LF for source and documentation files. No published migration content was changed.

## 2026-10-25 — Account approval administration boundary

M02C introduces only the administrator authorization needed by account-state routes: an authenticated active session plus a current `owner` or `admin` assignment queried from `user_roles`. General RBAC remains M02F. Account transitions are non-idempotent state-machine operations serialized with a row lock and audited atomically. Blocking revokes all live sessions in the same transaction; unblocking never restores them.

The initial owner is assigned only through the local `bootstrap:owner` CLI. It selects an already registered phone, takes a transaction-scoped advisory lock, refuses when any owner exists, activates the selected account, assigns the owner role, and audits the operation. It is not an HTTP endpoint or startup action.

## 2026-10-25 — Numeric internal identifier foundation

Before production data existed, M01R explicitly replaced the development migration baseline's UUID entity identifiers. Entity `id` primary keys now use `BIGINT GENERATED BY DEFAULT AS IDENTITY`; internal foreign keys, one-to-one keys, composite relationship columns, function parameters, and polymorphic audit references use `BIGINT`. PostgreSQL generates entity IDs and repositories return them with `RETURNING`; services do not generate database entity IDs.

Node `pg` returns `BIGINT` values as strings. JWT `sub`/`sid` and API identifiers therefore use canonical positive decimal strings bounded to PostgreSQL `BIGINT`, without conversion through JavaScript `Number`. Numeric identifiers are not promised to be sequential or gapless and are never renumbered.

Randomness remains where it is part of a security or external protocol rather than entity identity: OAuth state, nonce, PKCE verifier and encryption IVs, password salts, token hashes, and provider identifiers. `sms_deliveries.idempotency_key` remains the sole UUID database column because it is an opaque retry key. The migration-cycle script also uses a random UUID only to create a collision-resistant disposable database name.

The rewrite was permitted only after confirming the local development database contained no application data beyond role seeds and taking a `pg_dump` backup. `everest_db` was dropped/recreated and migrated from the rewritten baseline; destructive rollback testing ran only against a separately created disposable database.

## 2026-10-24 — Native JavaScript ES Modules

EVEREST uses native JavaScript ES Modules throughout the backend. `package.json` declares `"type": "module"`; local imports include `.js` extensions. This explicit decision replaces the earlier provisional CommonJS fallback for an empty repository.

## 2026-10-24 — Database configuration

Application and migration processes use the same validated `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` settings from `src/configs/env.js`. `DATABASE_URL` is not required. TLS is opt-in through `DB_SSL`; certificate verification is not disabled implicitly.

## 2026-10-24 — Migration rollback safety

Initial migrations have destructive `down` operations and are intended for disposable databases only. The migration runner permits `down` only when the configured database name clearly contains `test`, `tmp`, `temp`, or `disposable`. Down migrations reverse dependencies without `CASCADE`.

## 2026-10-24 — Telegram OIDC identity and session boundary

Telegram login uses the provider's OpenID Connect Authorization Code Flow with PKCE S256 and discovery metadata. The fixed expected issuer is `https://oauth.telegram.org`; ID tokens require a valid signature, audience, expiry, nonce, and non-empty subject. Only the verified `(provider, issuer, subject)` tuple is a login identity. Phone, username, and chat ID are never used to merge users.

Temporary authorization records store SHA-256 hashes of state and nonce. The PKCE verifier is encrypted with AES-256-GCM using a key derived from the configured Telegram client secret. Records expire, are atomically consumed exactly once before code exchange, and distinguish login from authenticated account linking.

Telegram login identity remains in `auth_identities`; bot messaging permission remains separately in `telegram_connections`. A verified `telegram:bot_access` grant may create or reactivate the connection. Unlinking is rejected when Telegram is the user's last login method. Link/unlink writes and audit events share one PostgreSQL transaction.

Successful login creates an `auth_sessions` row and an EVEREST HS256 session token. The callback puts the token in an `HttpOnly`, `SameSite=Lax` cookie and does not include it in JSON. Every authenticated request verifies both the token and the live, unrevoked session plus active account status.

## 2026-10-25 — Phone/password registration and login boundary

M02B registration accepts a normalizable E.164 phone, first and last names, and a password. It creates a pending user, profile, unverified non-primary phone, password credential, student role, and audit event atomically. Registration neither verifies phone ownership nor creates a session; phone verification and account approval remain later milestones.

Passwords must be 12–128 Unicode characters and contain at least one letter and one number. They are hashed asynchronously with Node.js `scrypt` using a random 16-byte salt, cost `N=16384`, `r=8`, `p=1`, and a 64-byte derived key. Stored hashes are self-describing. Verification uses `timingSafeEqual`, and unknown-phone login verifies against a valid dummy hash to reduce timing differences.

Password login uses a generic invalid-credentials response for unknown phones and wrong passwords. A correct password still requires an active account. Session creation, `last_login_at`, and a successful-login audit share one transaction; the access token uses the same server-side session and HttpOnly cookie contract as Telegram login.

## 2026-11-02 — Development seed script

`npm run seed:demo` (`scripts/seed-demo.js`) seeds demo accounts and content through the existing services, so validation and audit events apply. It adds no SQL and no migration.

- **Safety.** It prints the target database before doing anything. It refuses `NODE_ENV=production` unconditionally, and refuses a `DB_NAME` that contains none of `dev`, `test` or `demo` unless `--force` is passed. There is no `--reset` flag; a disposable database is recreated instead.
- **Idempotency by lookup.** Each step looks the entity up (phone, subject code, course/module/lesson title, group and bank code, question external id) or treats the service's own conflict code as "exists". A rerun after an interrupted run resumes at the first unfinished step.
- **Owner.** The demo owner is created with `bootstrapOwnerService`, as in `bootstrap:owner`. If an owner already exists, the demo owner is skipped and reported, and that existing owner acts as the actor for approvals and role changes.
- **Passwords.** `--password`, else `SEED_PASSWORD`, else a random password printed once. It is never stored. Reruns do not reset the password of an existing account.
- **Roles.** They are raised only from the bare `student` role, so manual role changes after seeding are kept.
- **Test.** `tests/integration/seed-demo.test.js` creates its own database, because a seeded owner would otherwise leak into the shared disposable database used by the other tests.

## 2026-11-05 — Rich demo content in the seed

- **Old content kept.** The English "Biology Fundamentals (demo)" course, its bank, quiz and group A stay; the new content is added beside them and reuses the subject codes `demo-biology` and `demo-chemistry` and the bank `demo-biology-bank`, so a rerun on an older database adds Tajik and Russian titles and the new records instead of duplicating subjects. The original draft chemistry course is the one draft course.
- **Extra accounts.** Phones `09` to `20` are students; `21` and `22` are two more teachers (group and course permissions need teachers to differ, and only the `teacher` role is eligible); `23` and `24` pending, `25` blocked, `26` rejected.
- **Past states.** The API refuses access windows that have already ended and assignments that close in the past. The seed passes the services' existing `clock` parameter for expired enrollments and module grants, and moves assignment windows into the past with the update API. No SQL and no new code paths in services.
- **Reruns.** Every record is found by phone, code, title or external id. An archived group is skipped as a whole because archived groups refuse members and announcements. Enrollments are skipped when any enrollment row exists, so a revoked demo enrollment is never reinstated by a rerun. A module or question that a person moved back to draft after seeding would be published again.
- **Video lessons** stay drafts because there is no real storage to hold a video.
- **Report.** The run prints a summary per entity (created / existing) and a checklist of accounts and screens; `--verbose` prints every record.

## 2026-11-13 — NCT mock exam

- **One engine.** A mock exam is a test with `origin = 'mock_exam'` (mode `nct`, no course, `max_attempts` 1, `after_submission`, no shuffling), a one-user assignment and one attempt, created in one transaction like a trainer test. Start, timer, autosave, grading, expiry and the sweep are the M11 engine's. `tests_origin_check` and `tests_course_required_check` were widened; every authored-test query already filters `origin = 'authored'`, so admin lists and staff results do not show mock exams, and trainer queries filter `origin = 'trainer'`, so the two modes never mix.
- **Blueprints are data.** `exam_blueprints` (code, titles, language, bank prefix, duration), `exam_blueprint_sections` (subject order by subject **code**, since subjects are not seeded by migrations) and `exam_blueprint_items` (sheet-number range, kind, points, scoring, form requirements, difficulty rule). Migration `20261113010000000` seeds `nct-a5` with the official values: 105 questions, 220 minutes, 40 points per subject, 160 in total. Ranges must cover 1..N without gaps; the service checks this (`500 MOCK_EXAM_BLUEPRINT_INVALID`).
- **Snapshot.** `tests.generation_filters` keeps the blueprint as it was at creation (sections, ranges, points, maxima, subject titles); results and history read it, never the live blueprint tables. Points per position are `test_questions.points` and frozen in `attempt_questions.max_points`.
- **Matching** already had partial credit: points × right pairs ÷ max(key pairs, given pairs), rounded down to a hundredth. At 4 points for a 4-pair key this is exactly 1 per pair, so no grading change was needed; the blueprint records `scoring = 'per_pair'`.
- **Cells.** The grading snapshot of a cells question gets `answerFormat: 'digits'`, `maxDigits` and `acceptedDigits` (the key's digits: `String(value)` for numeric, spaces removed for short_text, leading zeros dropped). The engine then accepts only `{ digits }` of 1..maxDigits characters `0-9` (`400 VALIDATION_ERROR` otherwise) and awards full points for a match. **Leading zeros are ignored** (`0012` = `12`): the sheet has four cells and a student may fill them from the left or right. `startAttemptInTransactionService` takes these extra snapshot fields; other attempts are unchanged.
- **Eligibility** is checked in SQL at assembly and counting: single = `single_choice` with exactly `option_count` options; matching = exactly `left_count` × `right_count` items and a key of `left_count` pairs; cells = numeric with a JSON number key matching `^[0-9]{1,4}$`, or short_text whose every accepted answer matches after removing whitespace.
- **Difficulty.** Each range may narrow difficulty (`difficulty_min/max`, NULL in the seed) and orders picked questions easy to hard (`difficulty_order = 'ascending'`, the seed). No per-position difficulty shares were seeded: the official per-position distribution is not known, and hard bounds would make some subjects unassemblable (khimiya has 12 single questions above difficulty 2). Open for the owner's numbers.
- **Selection.** Per range: questions the user has not met in an earlier mock exam first, then random; no question twice in one exam. Repeats across exams are allowed once unseen questions run out. All shortages are collected and returned together (`409 MOCK_EXAM_NOT_ENOUGH_QUESTIONS`, `field = <subjectCode>.<kind>`).
- **Concurrency.** A per-user advisory lock (`mock-exam:<id>`) serialises creation: one running mock exam per user (`409 MOCK_EXAM_IN_PROGRESS` with the id). Optional `idempotencyKey` with a partial unique index per user; the same key for another blueprint is `409 IDEMPOTENCY_KEY_REUSED`.
- **Expiry: lazy plus sweep.** Every mock exam route first finishes the user's expired attempts (as the learner test routes do); answers and flags after the deadline return `409 ATTEMPT_DEADLINE_PASSED` after the attempt is finished in the same request. The existing `worker:attempts` sweep (SKIP LOCKED, safe under PM2) finishes exams nobody opens again. No new worker.
- **Flags** live in `mock_exam_items` (one row per attempt question: section, sheet number, kind, `flagged`), which also gives the subject grouping. Flags do not affect grading and stay visible in the result.
- **Access** reuses `trainer.use` and the active-account check; the trainer's error codes are reused.
- **Language codes.** The project's Tajik code is `tg` (not `tj`); blueprint titles use `ru`, `tg`, `en`.

## 2026-11-12 — Administrators and owners use the NCT trainer

- **Why staff could not.** Only one thing: `trainer.use` was bound to the `student` role alone. Nothing else is role-specific: the attempt routes (`/tests/attempts/:id`, answers, submit, result) check only the owner of the attempt and, for `origin = 'trainer'`, an active account; there is no `attempts.take`-style permission.
- **Change.** Migration `20261112010000000` binds `trainer.use` to `admin` and `owner` (idempotent, by role code; `down` removes only these two bindings). The service still checks the permission, not a role list, and the error code for an account without it stays `TRAINER_STUDENT_ROLE_REQUIRED`. Teachers still lack it.
- **Visibility.** Trainer tests are `origin = 'trainer'`, so authoring lists, assignment lists and staff results (`origin = 'authored'`) never show them, also to their author. The author reads own attempts through the learner routes, which filter by `attempt.user_id` only.
- **Isolation.** All trainer reads are per user. The only cross-user aggregates over attempts in the code are the staff results of authored tests, which exclude trainer tests. Bonus, achievement and rating tables exist but nothing computes them from attempts yet; when that code is written it must filter `origin = 'authored'` (or exclude trainer tests) so staff and practice attempts do not count.

## 2026-11-11 — NCT trainer access and the /nct overview

- **Access replaces the 2026-11-10 rule.** The trainer is its own module and does not depend on courses or enrollments. Access needs two things, both existing mechanisms:
   - `users.status = 'active'`, i.e. an administrator approved the account and did not block it. Failing that returns the code login already uses, `403 ACCOUNT_NOT_ACTIVE`.
   - The RBAC permission `trainer.use`, granted to the `student` role by migration `20261111010000000`. Failing that returns `403 TRAINER_STUDENT_ROLE_REQUIRED`.
   - The authentication middleware checks neither the status nor the role, so the trainer service checks both.
   - `TRAINER_ACCESS_DENIED` and the catalog's `accessible` are removed.
- **No course for trainer tests.** `tests.course_id` is nullable only for `origin = 'trainer'` (`tests_course_required_check`). A service container course was rejected:
   - its tests would still need enrollments to pass the attempt access check;
   - it would show up in course lists;
   - it could be mistaken for real content.
   - Risk of NULL: code that reads `course_id` of a test must not assume it exists. Every authored-test query already filters `origin = 'authored'`.
   - The attempt service's `requireContentAccess` handles `origin = 'trainer'` first and checks only the account. Revoking enrollments therefore never affects a running training, while blocking the account stops it.
   - Trainer tests created before this change keep their course but follow the same rule.
- **Overview formulas.**
   - Subject readiness = Σ score ÷ Σ max score over the last `TRAINER_READINESS_WINDOW` (5) finished trainings of the subject, × 100. This is the share of correct answers, weighted by questions.
   - Overall readiness = the mean of the subject values (each trained subject equally); `null` when there are none.
   - Weak topics are computed over all finished trainings: per topic, questions met and questions with full points. A topic needs at least `TRAINER_WEAK_TOPIC_MIN_ANSWERS` (5) questions and must be below 100%. The lowest share comes first, then the most questions. The limit is `TRAINER_WEAK_TOPICS_LIMIT` (5).
   - Recent results: the last `TRAINER_RECENT_RESULTS_LIMIT` (5) finished trainings.
   - Only finished trainings (`graded`, `expired`) count.
- **Empty state** is `200` with `empty: true`, never an error.

## 2026-11-10 — NCT trainer

- **No second engine.** A training is a test generated for one student (`tests.origin = 'trainer'`, mode `practice`) with test questions, a one-student assignment and an attempt, all in one transaction. Start, autosave, timer, grading, reveal and result come from M11 unchanged, so the rules match regular tests exactly.
- **Snapshot.** As for every attempt: keys, explanations and option/item keys are frozen in `attempt_questions.grading_snapshot` at start, and the shown content comes from published questions, which cannot change.
- **Access (proposed minimum, open for review).** The platform has no paid trainer entitlement. The trainer for a subject therefore requires an active enrollment in a published course with that `subject_id`, which an administrator grants. The earliest such course hosts the generated test, so the ordinary `COURSE_ENROLLMENT_REQUIRED` check covers the running attempt too. Module grants do not apply, because the test has no module. In `everest_db` today only Biology has such a course.
- **Policy of a training:** no timer, `max_attempts` 1, `result_policy` first, `answer_reveal_policy` after_submission (revealed immediately after submit), 1 point per question, questions shuffled once at creation, options in book order.
- **Selection:** published, key `verified`, bank code prefix `nct-` (config), subject, language (default: the subject's primary language), optional section/topic code. Difficulty levels map to `questions.difficulty` ranges from config (`easy 1-2, medium 3, hard 4-5`). `mixed` splits the count 30/40/30 by largest remainder and fills a short level from all levels. Questions the student met in earlier trainings are picked last (`ORDER BY seen, random()`).
- **Counts** come from a configured set (`10,20,30,50`, capped by `TRAINER_MAX_QUESTIONS`). Too few matches return `409 TRAINER_NOT_ENOUGH_QUESTIONS` with the available number.
- **Concurrency/idempotency.** A per-student advisory lock serialises generation, so a student has one running training at a time (`409 TRAINER_ATTEMPT_IN_PROGRESS`). An optional `idempotencyKey` is stored in `generation_filters`, with a partial unique index per student; a repeat returns the same attempt, and the same key with other parameters returns `409 IDEMPOTENCY_KEY_REUSED`. Submit is the existing idempotent submit.
- **Hidden from staff screens.** Admin test lists, test detail/edit, lesson links, extra-attempt grants, staff results and course assignment lists filter `origin = 'authored'`. Staff can therefore not see trainer results yet (next step).
- **Result DTO:** `correct` added to reviewed questions (full points), for all attempts. It is additive.

## 2026-11-09 — Merge of the duplicate Tajik subject

- **Canonical subject:** `zaboni-tochiki` (the older one). `tajik_language` (created by the `nct-tg-2026` import) is merged into it and deleted; subjects have no archive state.
- **Migration `20261109010000000_merge-tajik-subjects`** finds both by code and does nothing when either is missing, so it is idempotent and safe on fresh databases. It moves banks, questions, question topics, sections, topics and courses in one statement, because the composite `(id, subject_id)` foreign keys are not deferrable and are only satisfied once parents and children agree.
- **Immutability guards.** Changing `subject_id` alters no question content, but `questions_guard` and `question_topics_guard` reject any column change on published questions. The migration disables just those two triggers inside its transaction and re-enables them before commit; services never do this.
- **Values.** Canonical values win: existing translations (the canonical `tg` title "Забони Точики" is kept; the duplicate's "Забони тоҷикӣ" is dropped) and color. Only missing translations, and a color when the canonical one is `neutral`, move over.
- **Conflicts.** A section or topic code present in both subjects aborts the migration (`TAJIK_SUBJECT_MERGE_CONFLICT`) rather than guessing how to merge two taxonomy entries. The real data had none.
- **Checks inside the migration:** question count of the canonical subject after = both subjects before; no table with a `subject_id` column still references the old id.
- **Down** is a no-op: the merge cannot be undone without the dropped id.
- **Importer alias.** `question-import-service` maps `tajik_language` to `zaboni-tochiki` (subject entries, `subjectCode` fields, `bank.subjectCode`), warns `SUBJECT_CODE_ALIASED` and never updates the canonical titles from an aliased entry. The alias is a constant in code, not a table: one known case does not justify a schema change.

## 2026-11-05 — Lesson-test link and HTTP question import

**Link direction.** `lessons.test_id`, not `tests.lesson_id`: `guard_test()` rejects any column change on a published test, so a link stored on the test could not be set after publication. It also lets several lessons share a test. Composite foreign keys `(test_id, course_id)` and `(module_id, course_id)` make cross-course links impossible in the database; a CHECK limits links to `test` and `mixed` lessons.

- A `mixed` lesson may have no test. A `test` lesson needs one to publish. Draft lessons may hold a draft test.
- Lesson link and publish take `FOR SHARE` on the test; test archive takes `FOR UPDATE` and then reads the lessons, so the two cannot interleave.
- An archived test may stay linked to a draft or archived lesson; only published lessons block archiving. Publishing that lesson later returns `TEST_NOT_PUBLISHED`.
- New codes: `LESSON_TEST_REQUIRED`, `TEST_ARCHIVED`, `TEST_LINKED_TO_LESSON`. `TEST_NOT_PUBLISHED` is reused.
- Course copy has no test copying, so links are cleared and counted. `tests.module_id` is stored and validated, but nothing enforces it yet; M11 decides how it affects a start.
- Permissions are unchanged: `lessons.manage` to link. The picker is `GET /admin/tests`, with its `tests.read` scope. The lesson routes do not check `tests.read` themselves, because the link is limited to the lesson's own course.

**HTTP import.**

- Transport is a raw `application/zip` body read after auth, CSRF, permission and rate checks; no new dependency and no presigned flow. Storage may be unconfigured, and a package must be readable by the importer anyway.
- Packages wait on local disk in `QUESTION_IMPORT_UPLOAD_DIR` under server-generated names, never names from the archive. The API and the worker must therefore share a disk: one host only.
- New table `question_import_uploads` holds the state between dry run and run, because `question_imports.bank_id` is NOT NULL and the bank may not exist before the run. Polling therefore uses `GET /packages/:uploadId` until `runId` is set, then the existing run endpoints.
- The worker (`npm run worker:imports`) is a separate process, started explicitly. Claims use `SKIP LOCKED`; a 5-minute lease is renewed by a heartbeat. A lost worker is failed (`IMPORT_WORKER_LOST`), not retried, and its `importing` run is marked `failed`; a retry needs a new `idempotencyKey`, the existing rule for failed runs.
- Idempotency stays on `(bank, idempotency_key)`, default `package-<sha256>`. `applyMatchingDefaults` adds a suffix, because it changes what is written.
- All-or-nothing on storage means: no database write and no run when storage is missing. It is checked at confirm and again in the shared importer. A storage failure partway through image uploads can leave unreferenced content-addressed objects, as before; the database stays untouched.
- The ZIP reader gained a total unpacked limit (512 MiB, from declared sizes that also bound inflation) and rejects control characters in paths.
- Matching defaults are an import option rather than a bulk endpoint: they apply to drafts only, reuse the importer and are reported per question.

## 2026-11-12 — Trainer cells questions use the mock exam digits format

- **Rule:** a trainer question is a cells question exactly when the mock exam would take it for a `cells` item: its subject has a `cells` item in an active blueprint, and its verified key passes the shared `cellsKeyFilter` (`numeric`/`short_text`, whole number of 1..maxDigits digits). `max_digits` and `points` come from that blueprint item (nct-a5: 4 digits, 2 points). No new rule and no migration.
- **Snapshot:** cells trainer questions get the mock exam's digits grading snapshot (`digitsSnapshot`) plus `acceptsValue: true`, so `{ value }` from an old client is stored as `{ digits }`; the mock exam keeps rejecting `{ value }`. Attempts created earlier keep their snapshot and `{ value }` grading.
- **Views:** `kind`, `answerFormat`, `maxDigits` come from the snapshot (not the key) and appear only on digits questions; review views add the mock exam `sheet`. Lesson tests are unchanged.

## 2026-11-14 — Resumable lesson video uploads

- **No second mechanism.** The request described a `video_uploads` table; `asset_uploads` + `assets` already hold every listed field (owner, size, type, storage upload id, server-built key, part size/count, status, `expires_at`, asset id). It gained `lesson_id`, `expired_at` and the states `uploading` and `expired` (migration `20261114010000000`). `completing` is not stored: completion is one transaction under a row lock, so a second call waits and returns the same result.
- **Limits.** `VIDEO_MAX_BYTES` 4 GiB, `VIDEO_TOTAL_QUOTA_BYTES` 15 GiB (ready videos plus open uploads, checked under an advisory lock), `VIDEO_MAX_ACTIVE_UPLOADS` 3 per user. They apply to `kind: video` only; materials keep the 20 GiB cap and no count limit.
- **Lifetimes.** Part URLs 1 h (`STORAGE_PRESIGN_TTL_SECONDS` default 3600), upload session 48 h (`STORAGE_UPLOAD_TTL_HOURS`, max 70), bucket rule aborts incomplete multipart after 3 days (was 7), playback URLs 2 h (`VIDEO_PLAYBACK_URL_TTL_SECONDS`). Supersedes the 144 h / 7-day values of the M07 decision.
- **Cleanup.** `worker:attempts` also runs `expireNextAbandonedUploadService` (SKIP LOCKED) when storage is configured. Replacing or removing a lesson video archives the asset and deletes its object after commit if no lesson or resource still uses it; an archived video cannot be attached again (an earlier test that swapped back to a replaced video was changed).
- **Attach on completion** goes through `updateLessonService`, so lesson rules (type, chapters, offline license revocation, old-video removal) are not duplicated; a refused attach leaves a ready asset and reports `errorCode`.
- **No transcoding.** Recommendation for later: a separate HLS worker (ffmpeg, 2–3 renditions, segments under `courses/:id/hls/…`, `processing_status` pending→completed) on a machine other than the shared VPS; until then authors upload fast-start MP4 (H.264/AAC).
