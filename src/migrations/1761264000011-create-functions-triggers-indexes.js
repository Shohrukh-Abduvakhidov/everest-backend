export const up = pgm => {
  pgm.sql(`
-- Запросы кабинета, очередей и отчётов. Дополнительные индексы FK добавлены ниже.
CREATE INDEX group_members_active_idx ON group_members(user_id,group_id) WHERE status = 'active';
CREATE INDEX group_announcements_feed_idx ON group_announcements(group_id,is_pinned,published_at);
CREATE INDEX course_enrollments_user_idx ON course_enrollments(user_id,expires_at);
CREATE INDEX questions_filter_idx ON questions(bank_id,status,question_type,language_code,difficulty);
CREATE INDEX questions_subject_idx ON questions(subject_id,status);
CREATE INDEX attempts_user_history_idx ON test_attempts(user_id,started_at);
CREATE UNIQUE INDEX attempts_one_open_idx ON test_attempts(assignment_id,user_id)
WHERE status IN ('in_progress','paused');
CREATE INDEX ai_messages_history_idx ON ai_messages(conversation_id,created_at);
CREATE INDEX ai_analyses_latest_idx ON ai_analyses(user_id,analysis_type,created_at);
CREATE INDEX bonus_ledger_balance_idx ON bonus_transactions(account_id,created_at);
CREATE INDEX notifications_inbox_idx ON notifications(user_id,created_at);
CREATE INDEX delivery_pending_idx ON notification_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX jobs_claim_idx ON background_jobs(available_at,created_at) WHERE status = 'pending';
CREATE INDEX jobs_lease_idx ON background_jobs(lease_expires_at) WHERE status = 'running';
CREATE INDEX learning_activity_user_idx ON learning_activity_events(user_id,occurred_at);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys(expires_at);

-- Эффективный доступ. Вызывать с user_id из серверной сессии, а не из тела запроса.
-- Проверка сессии и полномочий администратора/преподавателя выполняется отдельно.
CREATE FUNCTION can_access_module(p_user BIGINT, p_module BIGINT, p_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM users u
  JOIN course_enrollments e ON e.user_id = u.id
  JOIN courses c ON c.id = e.course_id
  JOIN course_modules m ON m.course_id = c.id
  JOIN module_access_grants g ON g.user_id = u.id AND g.module_id = m.id AND g.course_id = c.id
  WHERE u.id = p_user AND m.id = p_module AND u.status = 'active'
   AND u.onboarding_completed_at IS NOT NULL AND c.status = 'published' AND m.status = 'published'
   AND e.revoked_at IS NULL AND e.begins_at <= p_at AND (e.expires_at IS NULL OR e.expires_at > p_at)
   AND g.revoked_at IS NULL AND g.begins_at <= p_at AND (g.expires_at IS NULL OR g.expires_at > p_at)
 );
$$;

-- Сериализация правок дочерних элементов с публикацией вопроса.
CREATE FUNCTION assert_question_draft(p_question BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
 SELECT status INTO v_status FROM questions WHERE id = p_question FOR UPDATE;
 IF v_status IS DISTINCT FROM 'draft' THEN
  RAISE EXCEPTION 'QUESTION_IMMUTABLE: create a question copy';
 END IF;
END; $$;

CREATE FUNCTION guard_question_child() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN PERFORM assert_question_draft(OLD.question_id); END IF;
 IF TG_OP <> 'DELETE' THEN
  IF TG_OP = 'INSERT' THEN PERFORM assert_question_draft(NEW.question_id);
  ELSIF NEW.question_id <> OLD.question_id THEN PERFORM assert_question_draft(NEW.question_id); END IF;
  RETURN NEW;
 END IF;
 RETURN OLD;
END; $$;

CREATE FUNCTION guard_question() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  IF OLD.status <> 'draft' THEN
   IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'QUESTION_IMMUTABLE'; END IF;
   IF NEW.status = 'draft' OR (to_jsonb(NEW) - 'status' - 'updated_at') <>
       (to_jsonb(OLD) - 'status' - 'updated_at') THEN RAISE EXCEPTION 'QUESTION_IMMUTABLE'; END IF;
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF NEW.status = 'published' THEN
  IF NOT EXISTS (SELECT 1 FROM question_answer_keys k WHERE k.question_id = NEW.id
       AND k.status = 'verified' AND k.answer_data IS NOT NULL) THEN
   RAISE EXCEPTION 'QUESTION_REQUIRES_VERIFIED_KEY';
  END IF;
  IF NEW.question_type IN ('single_choice','multiple_choice') AND
     (SELECT count(*) FROM question_options WHERE question_id = NEW.id) < 2 THEN
   RAISE EXCEPTION 'QUESTION_REQUIRES_OPTIONS';
  END IF;
  IF NEW.question_type = 'matching' AND (
      jsonb_typeof(NEW.interaction_settings -> 'requireAllLeft') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(NEW.interaction_settings -> 'allowRightReuse') IS DISTINCT FROM 'boolean'
      OR NOT EXISTS (SELECT 1 FROM question_matching_items WHERE question_id=NEW.id AND side='left')
      OR NOT EXISTS (SELECT 1 FROM question_matching_items WHERE question_id=NEW.id AND side='right')
     ) THEN RAISE EXCEPTION 'MATCHING_RULES_AND_ITEMS_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER questions_guard BEFORE INSERT OR UPDATE OR DELETE ON questions
FOR EACH ROW EXECUTE FUNCTION guard_question();
CREATE TRIGGER question_options_guard BEFORE INSERT OR UPDATE OR DELETE ON question_options
FOR EACH ROW EXECUTE FUNCTION guard_question_child();
CREATE TRIGGER question_matching_guard BEFORE INSERT OR UPDATE OR DELETE ON question_matching_items
FOR EACH ROW EXECUTE FUNCTION guard_question_child();
CREATE TRIGGER question_keys_guard BEFORE INSERT OR UPDATE OR DELETE ON question_answer_keys
FOR EACH ROW EXECUTE FUNCTION guard_question_child();
CREATE TRIGGER question_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON question_assets
FOR EACH ROW EXECUTE FUNCTION guard_question_child();
CREATE TRIGGER question_topics_guard BEFORE INSERT OR UPDATE OR DELETE ON question_topics
FOR EACH ROW EXECUTE FUNCTION guard_question_child();

CREATE FUNCTION guard_test_question() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  SELECT status INTO v_status FROM tests WHERE id=OLD.test_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'TEST_IMMUTABLE'; END IF;
 END IF;
 IF TG_OP <> 'DELETE' THEN
  SELECT status INTO v_status FROM tests WHERE id=NEW.test_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'TEST_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 RETURN OLD;
END; $$;

CREATE FUNCTION guard_test() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  IF OLD.status <> 'draft' THEN
   IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'TEST_IMMUTABLE'; END IF;
   IF NEW.status = 'draft' OR (to_jsonb(NEW) - 'status' - 'updated_at') <>
      (to_jsonb(OLD) - 'status' - 'updated_at') THEN RAISE EXCEPTION 'TEST_IMMUTABLE'; END IF;
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF NEW.status = 'published' THEN
  IF NOT EXISTS (SELECT 1 FROM test_questions WHERE test_id=NEW.id) THEN
   RAISE EXCEPTION 'TEST_REQUIRES_QUESTIONS';
  END IF;
  IF EXISTS (SELECT 1 FROM test_questions tq JOIN questions q ON q.id=tq.question_id
       WHERE tq.test_id=NEW.id AND q.status <> 'published') THEN
   RAISE EXCEPTION 'TEST_REQUIRES_PUBLISHED_QUESTIONS';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER tests_guard BEFORE INSERT OR UPDATE OR DELETE ON tests
FOR EACH ROW EXECUTE FUNCTION guard_test();
CREATE TRIGGER test_questions_guard BEFORE INSERT OR UPDATE OR DELETE ON test_questions
FOR EACH ROW EXECUTE FUNCTION guard_test_question();

-- Журналы не редактируются: исправление — новая компенсирующая операция.
CREATE FUNCTION forbid_ledger_rewrite() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'APPEND_ONLY_LEDGER'; END; $$;
CREATE TRIGGER bonus_transactions_append_only BEFORE UPDATE OR DELETE ON bonus_transactions
FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();
CREATE TRIGGER ai_usage_append_only BEFORE UPDATE OR DELETE ON ai_usage_ledger
FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();
CREATE TRIGGER score_revisions_append_only BEFORE UPDATE OR DELETE ON attempt_score_revisions
FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();

-- Служебная запись аудита может быть привязана к любому объекту платформы.
-- entity_id — намеренно полиморфный идентификатор, не FK.
ALTER TABLE audit_events ADD COLUMN entity_type TEXT;
ALTER TABLE audit_events ADD COLUMN entity_id BIGINT;

-- Первоначальный справочник ролей; identity-значения назначает PostgreSQL.
INSERT INTO roles (code) VALUES
 ('owner'),
 ('admin'),
 ('teacher'),
 ('student');

-- Правила авторизации из первого инкремента:
-- ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА BACKEND (не реализованы одним этим DDL).
-- 1. Регистрация: SMS подтверждает номер; затем users + profile + phone +
--    password + student role создаются транзакционно, статус pending.
--    Не сохранять выбранный пароль в challenge: передавать его при финализации.
--    Первого owner создать контролируемой bootstrap-командой, не публичным API.
-- 2. Telegram: проверять подпись/issuer/audience/expiry/nonce и state/PKCE выбранного
--    официального flow; subject брать из проверенного токена. Не доверять JSON клиента.
--    Не объединять пользователей по имени, username или совпавшему телефону.
--    provider_profile содержит только разрешённые публичные поля, не ID/access tokens.
-- 3. Telegram-only аккаунт может не иметь phone/password. Полноценный учебный доступ
--    требует active и завершённого профиля. Обязательность телефона перед активацией
--    пока не согласована. Password row создаётся лишь при установке пароля.
-- 4. Для установки пароля после Telegram-входа: свежая повторная аутентификация;
--    для входа по телефону дополнительно нужен привязанный подтверждённый номер.
-- 5. Привязка Telegram и изменение номера требуют свежего подтверждения личности.
--    Нельзя отвязать последний доступный способ входа. Нельзя использовать SMS
--    регистрации для смены пароля существующего аккаунта.
-- 6. SMS-код: криптографическая генерация; HMAC с серверным секретом + challenge ID
--    либо стойкое хеширование. Простой SHA256 короткого кода недостаточен.
--    Пять попыток здесь — предложение; TTL, cooldown и дневные лимиты настроить в API.
--    При перевыпуске кода атомарно инвалидировать старые: блокировка по номеру/назначению.
-- 7. Восстановление: только уже привязанный verified номер; сверять snapshot номера
--    с user_phones, состояние аккаунта и purpose. Неизвестному номеру вернуть тот же
--    общий ответ, без SMS и реального reset challenge. Ограничить IP/номер/общий бюджет.
-- 8. Финальный reset endpoint принимает challenge ID, код и новый пароль вместе.
--    Под блокировками атомарно проверить TTL/попытки/неиспользованность, заменить hash,
--    consume challenge, отозвать все сессии и прочие reset challenges, записать аудит.
--    Не создавать бессрочный флаг password_reset_allowed после проверки кода.
-- 9. SMS API вызывается после фиксации challenge. Текст и код не сохраняются в delivery,
--    логах, metadata. При timeout неизвестного результата сверить ID/идемпотентность
--    провайдера, не отправлять новые платные SMS вслепую. Таблица delivery — журнал,
--    не полноценный outbox с возможностью восстановить исходный код для worker.
-- 10. Refresh: непрозрачные случайные токены; хранить только hash. Ротация под
--     блокировкой session/token; used_at старого + новый token в одной транзакции.
--     Повтор использованного токена отзывает всю session. Хранить использованные
--     хеши до окончания окна обнаружения replay. expires_at токена <= срока session.
-- 11. Каждый защищённый запрос проверяет user status/onboarding + session expiry/revoke
--     + права на ресурс. Отзыв/блокировка действует и для ещё не истёкшего access JWT.
--     Статeless JWT без серверной проверки этого не обеспечивает.
-- 12. Пароли — Argon2id или bcrypt с согласованными параметрами. Cookies: HttpOnly,
--     Secure, SameSite; CSRF/CORS по фактическим доменам. Секреты провайдера — окружение.
-- 13. updated_at обновляет backend; автоматического триггера пока нет. Проверять IANA
--     timezone; обязательность first/last_name при завершении профиля — в API.
-- 14. Физическое удаление пользователей не входит в эту версию; FK RESTRICT сохраняют
--     связи. Cleanup временных данных/сроки хранения IP/аудита разработать отдельно.
-- 15. roles/user_roles не дают доступ ко всем курсам: course_teachers и
--     course_enrollments с FK на users. Роль student должна проверяться сервером.
-- 16. user_profiles.avatar_asset_id связан с assets в этом полном baseline.
-- 17. Остальные модули включены ниже; внедряются поэтапно.

-- Дополнительные обязательные правила приложения:
-- 1. FK гарантируют принадлежность модуля курсу, но активность и сроки нужно
--    проверять на КАЖДОМ защищённом запросе, включая выдачу файла, тест и offline.
-- 2. group_members/group_teachers/group_announcements не выдают доступ к курсам.
-- 3. Видимый замок и отсутствие grant — не признак зарегистрированной неоплаты.
--    Платежи внутри платформы не согласованы, поэтому payments здесь нет.
-- 4. translations JSONB — необязательный словарь ru/tg/en, валидируется по DTO;
--    основное название хранится в title. content.blocks — общий контракт контента.
-- 5. При публикации API проверяет тип и ВСЕ ссылки answer_data; триггер проверяет
--    наличие verified ключа и базовую структуру, но не полную JSON Schema.
-- 6. Числовые допуски/частичные баллы/показ ответов/лимиты НЦТ — предложения,
--    не окончательные решения; задать при создании теста и сохранить policy_snapshot.
-- 7. grading_snapshot — служебный снимок ключа и правил для воспроизводимости;
--    он не второй редактируемый источник ключа. Никогда не отдавать его ученику.
-- 8. Начало/сдача/истечение/пауза: транзакция и блокировка attempt; после сдачи
--    запретить autosave. Конкуренцию autosave контролирует revision.
-- 9. Лимит попыток проверять с блокировкой по assignment/user до вставки.
--    В v0.2 лимит считается на назначение. Глобальная одна попытка НЦТ не введена.
-- 10. student_answers.awarded_points <= attempt_questions.max_points проверяет API.
-- 11. AI: заблокировать бюджет и все применимые daily_usage в стабильном порядке;
--    зарезервировать до внешнего вызова; после ответа атомарно settle/release.
--    Фактический расход записывать даже при превышении резерва; остановить новые
--    запросы. При timeout не освобождать резерв и не повторять оплату вслепую.
-- 12. Глобальные/групповые/курсовые политики здесь имеют ОБЩИЙ суточный пул.
--    Личный лимит задаётся policy.user_id. Единицы/значения и правила пакетов — уточнить.
--    Пакет за бонусы не обходит денежный бюджет центра.
-- 13. Баланс бонусов = SUM(delta); перед spend/refund блокировать bonus_accounts,
--    проверять остаток, писать ledger + redemption + credit grant одной транзакцией.
-- 14. Уведомления push проверять по владельцу notification/subscription, Telegram —
--    по владельцу connection; webhook — по подписи/секрету, без секретов в логах.
--    Exactly-once доставка внешнего сообщения не гарантируется одним UNIQUE.
-- 15. Broadcast audience_filter — валидируемый DSL, не произвольный SQL.
-- 16. Worker использует FOR UPDATE SKIP LOCKED, lease и идемпотентные обработчики.
--    payload/background_jobs/idempotency response не содержат пароли/OTP/токены.
-- 17. Агрегаты прогресса, рейтинга, streak вычисляются из первичных данных.
--    Порог завершения и знаменатель прогресса ещё не согласованы.
-- 18. Иерархию topics проверять на циклы в транзакции (не только parent_id <> id).
-- 19. Права staff на банки/группы/курсы проверяются по назначению; у одного teacher
--    нет автоматического доступа ко всем материалам. Родительские FK не являются ACL.
-- 20. Прогресс, ключи, сессии, аудит и учебные результаты не доступны публичным SQL.
--    Клиент работает только через API. Эта схема не включает готовую RLS-политику.
-- 21. INSERT/UPDATE балансов резервов, оценок и статусов не доступны ученическому API.
--    DB runtime role и миграционный владелец должны быть разделены при деплое.

-- Индексы дочерних FK (проверены по каталогу PostgreSQL).
CREATE INDEX fk_achievements_1_idx ON achievements (icon_asset_id);
CREATE INDEX fk_ai_analyses_2_idx ON ai_analyses (attempt_id);
CREATE INDEX fk_ai_analyses_3_idx ON ai_analyses (course_id);
CREATE INDEX fk_ai_analyses_4_idx ON ai_analyses (request_id);
CREATE INDEX fk_ai_conversations_5_idx ON ai_conversations (course_id);
CREATE INDEX fk_ai_conversations_6_idx ON ai_conversations (user_id);
CREATE INDEX fk_ai_credit_grants_7_idx ON ai_credit_grants (redemption_id,user_id);
CREATE INDEX fk_ai_credit_grants_8_idx ON ai_credit_grants (user_id);
CREATE INDEX fk_ai_limit_policies_9_idx ON ai_limit_policies (course_id);
CREATE INDEX fk_ai_limit_policies_10_idx ON ai_limit_policies (created_by);
CREATE INDEX fk_ai_limit_policies_11_idx ON ai_limit_policies (group_id);
CREATE INDEX fk_ai_limit_policies_12_idx ON ai_limit_policies (user_id);
CREATE INDEX fk_ai_messages_13_idx ON ai_messages (conversation_id,user_id);
CREATE INDEX fk_ai_request_reservations_14_idx ON ai_request_reservations (daily_usage_id);
CREATE INDEX fk_ai_requests_15_idx ON ai_requests (credit_grant_id,user_id);
CREATE INDEX fk_ai_requests_16_idx ON ai_requests (budget_period_id);
CREATE INDEX fk_ai_requests_17_idx ON ai_requests (conversation_id,user_id);
CREATE INDEX fk_ai_usage_ledger_18_idx ON ai_usage_ledger (request_id);
CREATE INDEX fk_announcement_assets_19_idx ON announcement_assets (asset_id);
CREATE INDEX fk_asset_aliases_20_idx ON asset_aliases (asset_id);
CREATE INDEX fk_assets_21_idx ON assets (uploaded_by);
CREATE INDEX fk_attempt_questions_22_idx ON attempt_questions (attempt_id,test_id);
CREATE INDEX fk_attempt_questions_23_idx ON attempt_questions (test_question_id,test_id,question_id);
CREATE INDEX fk_attempt_score_revisions_24_idx ON attempt_score_revisions (attempt_id);
CREATE INDEX fk_attempt_score_revisions_25_idx ON attempt_score_revisions (revised_by);
CREATE INDEX fk_bonus_offers_26_idx ON bonus_offers (created_by);
CREATE INDEX fk_bonus_redemptions_27_idx ON bonus_redemptions (offer_id);
CREATE INDEX fk_bonus_rules_28_idx ON bonus_rules (created_by);
CREATE INDEX fk_bonus_transactions_29_idx ON bonus_transactions (performed_by);
CREATE INDEX fk_bonus_transactions_30_idx ON bonus_transactions (reverses_id);
CREATE INDEX fk_bonus_transactions_31_idx ON bonus_transactions (rule_id);
CREATE INDEX fk_broadcast_campaigns_32_idx ON broadcast_campaigns (created_by);
CREATE INDEX fk_course_enrollments_33_idx ON course_enrollments (course_id);
CREATE INDEX fk_course_enrollments_34_idx ON course_enrollments (granted_by);
CREATE INDEX fk_course_enrollments_35_idx ON course_enrollments (revoked_by);
CREATE INDEX fk_course_favorites_36_idx ON course_favorites (course_id);
CREATE INDEX fk_course_teachers_37_idx ON course_teachers (assigned_by);
CREATE INDEX fk_course_teachers_38_idx ON course_teachers (user_id);
CREATE INDEX fk_courses_39_idx ON courses (cover_asset_id);
CREATE INDEX fk_courses_40_idx ON courses (created_by);
CREATE INDEX fk_courses_41_idx ON courses (subject_id);
CREATE INDEX fk_group_announcements_42_idx ON group_announcements (author_id);
CREATE INDEX fk_group_members_43_idx ON group_members (added_by);
CREATE INDEX fk_group_members_44_idx ON group_members (user_id);
CREATE INDEX fk_group_teachers_45_idx ON group_teachers (assigned_by);
CREATE INDEX fk_group_teachers_46_idx ON group_teachers (user_id);
CREATE INDEX fk_groups_47_idx ON groups (created_by);
CREATE INDEX fk_learning_activity_events_48_idx ON learning_activity_events (attempt_id);
CREATE INDEX fk_learning_activity_events_49_idx ON learning_activity_events (lesson_id);
CREATE INDEX fk_lesson_notes_50_idx ON lesson_notes (lesson_id);
CREATE INDEX fk_lesson_notes_51_idx ON lesson_notes (user_id);
CREATE INDEX fk_lesson_progress_52_idx ON lesson_progress (lesson_id);
CREATE INDEX fk_lesson_resources_53_idx ON lesson_resources (asset_id);
CREATE INDEX fk_lessons_54_idx ON lessons (created_by);
CREATE INDEX fk_lessons_55_idx ON lessons (module_id,course_id);
CREATE INDEX fk_lessons_56_idx ON lessons (video_asset_id);
CREATE INDEX fk_module_access_grants_57_idx ON module_access_grants (granted_by);
CREATE INDEX fk_module_access_grants_58_idx ON module_access_grants (module_id,course_id);
CREATE INDEX fk_module_access_grants_59_idx ON module_access_grants (revoked_by);
CREATE INDEX fk_module_access_grants_60_idx ON module_access_grants (user_id,course_id);
CREATE INDEX fk_notification_deliveries_61_idx ON notification_deliveries (push_subscription_id);
CREATE INDEX fk_notification_deliveries_62_idx ON notification_deliveries (telegram_connection_id);
CREATE INDEX fk_notifications_63_idx ON notifications (campaign_id);
CREATE INDEX fk_offline_downloads_64_idx ON offline_downloads (asset_id);
CREATE INDEX fk_offline_downloads_65_idx ON offline_downloads (lesson_id);
CREATE INDEX fk_offline_downloads_66_idx ON offline_downloads (user_id);
CREATE INDEX fk_platform_settings_67_idx ON platform_settings (updated_by);
CREATE INDEX fk_push_subscriptions_68_idx ON push_subscriptions (user_id);
CREATE INDEX fk_question_answer_keys_69_idx ON question_answer_keys (verified_by);
CREATE INDEX fk_question_assets_70_idx ON question_assets (asset_id);
CREATE INDEX fk_question_banks_71_idx ON question_banks (owner_id);
CREATE INDEX fk_question_banks_72_idx ON question_banks (subject_id);
CREATE INDEX fk_question_duplicate_links_73_idx ON question_duplicate_links (duplicate_of_id);
CREATE INDEX fk_question_duplicate_links_74_idx ON question_duplicate_links (marked_by);
CREATE INDEX fk_question_import_errors_75_idx ON question_import_errors (import_id);
CREATE INDEX fk_question_imports_76_idx ON question_imports (initiated_by);
CREATE INDEX fk_question_topics_77_idx ON question_topics (question_id,subject_id);
CREATE INDEX fk_question_topics_78_idx ON question_topics (topic_id,subject_id);
CREATE INDEX fk_questions_79_idx ON questions (bank_id,subject_id);
CREATE INDEX fk_questions_80_idx ON questions (created_by);
CREATE INDEX fk_questions_81_idx ON questions (import_id);
CREATE INDEX fk_questions_82_idx ON questions (source_question_id);
CREATE INDEX fk_student_answers_83_idx ON student_answers (attempt_question_id,question_id);
CREATE INDEX fk_student_answers_84_idx ON student_answers (graded_by);
CREATE INDEX fk_test_assignments_85_idx ON test_assignments (assigned_by);
CREATE INDEX fk_test_assignments_86_idx ON test_assignments (course_id);
CREATE INDEX fk_test_assignments_87_idx ON test_assignments (group_id);
CREATE INDEX fk_test_assignments_88_idx ON test_assignments (lesson_id);
CREATE INDEX fk_test_assignments_89_idx ON test_assignments (test_id);
CREATE INDEX fk_test_assignments_90_idx ON test_assignments (user_id);
CREATE INDEX fk_test_attempts_91_idx ON test_attempts (assignment_id,test_id);
CREATE INDEX fk_test_attempts_92_idx ON test_attempts (test_id);
CREATE INDEX fk_test_questions_93_idx ON test_questions (question_id);
CREATE INDEX fk_tests_94_idx ON tests (copied_from_id);
CREATE INDEX fk_tests_95_idx ON tests (created_by);
CREATE INDEX fk_topics_96_idx ON topics (parent_id,subject_id);
CREATE INDEX fk_topics_97_idx ON topics (section_id,subject_id);
CREATE INDEX fk_user_achievements_98_idx ON user_achievements (achievement_id);
CREATE INDEX fk_user_invitations_99_idx ON user_invitations (accepted_by);
CREATE INDEX fk_user_invitations_100_idx ON user_invitations (invited_by);
CREATE INDEX fk_user_profiles_101_idx ON user_profiles (avatar_asset_id);
  `);
};

export const down = pgm => {
  pgm.sql(`
DROP INDEX fk_user_profiles_101_idx;
DROP INDEX fk_user_invitations_100_idx;
DROP INDEX fk_user_invitations_99_idx;
DROP INDEX fk_user_achievements_98_idx;
DROP INDEX fk_topics_97_idx;
DROP INDEX fk_topics_96_idx;
DROP INDEX fk_tests_95_idx;
DROP INDEX fk_tests_94_idx;
DROP INDEX fk_test_questions_93_idx;
DROP INDEX fk_test_attempts_92_idx;
DROP INDEX fk_test_attempts_91_idx;
DROP INDEX fk_test_assignments_90_idx;
DROP INDEX fk_test_assignments_89_idx;
DROP INDEX fk_test_assignments_88_idx;
DROP INDEX fk_test_assignments_87_idx;
DROP INDEX fk_test_assignments_86_idx;
DROP INDEX fk_test_assignments_85_idx;
DROP INDEX fk_student_answers_84_idx;
DROP INDEX fk_student_answers_83_idx;
DROP INDEX fk_questions_82_idx;
DROP INDEX fk_questions_81_idx;
DROP INDEX fk_questions_80_idx;
DROP INDEX fk_questions_79_idx;
DROP INDEX fk_question_topics_78_idx;
DROP INDEX fk_question_topics_77_idx;
DROP INDEX fk_question_imports_76_idx;
DROP INDEX fk_question_import_errors_75_idx;
DROP INDEX fk_question_duplicate_links_74_idx;
DROP INDEX fk_question_duplicate_links_73_idx;
DROP INDEX fk_question_banks_72_idx;
DROP INDEX fk_question_banks_71_idx;
DROP INDEX fk_question_assets_70_idx;
DROP INDEX fk_question_answer_keys_69_idx;
DROP INDEX fk_push_subscriptions_68_idx;
DROP INDEX fk_platform_settings_67_idx;
DROP INDEX fk_offline_downloads_66_idx;
DROP INDEX fk_offline_downloads_65_idx;
DROP INDEX fk_offline_downloads_64_idx;
DROP INDEX fk_notifications_63_idx;
DROP INDEX fk_notification_deliveries_62_idx;
DROP INDEX fk_notification_deliveries_61_idx;
DROP INDEX fk_module_access_grants_60_idx;
DROP INDEX fk_module_access_grants_59_idx;
DROP INDEX fk_module_access_grants_58_idx;
DROP INDEX fk_module_access_grants_57_idx;
DROP INDEX fk_lessons_56_idx;
DROP INDEX fk_lessons_55_idx;
DROP INDEX fk_lessons_54_idx;
DROP INDEX fk_lesson_resources_53_idx;
DROP INDEX fk_lesson_progress_52_idx;
DROP INDEX fk_lesson_notes_51_idx;
DROP INDEX fk_lesson_notes_50_idx;
DROP INDEX fk_learning_activity_events_49_idx;
DROP INDEX fk_learning_activity_events_48_idx;
DROP INDEX fk_groups_47_idx;
DROP INDEX fk_group_teachers_46_idx;
DROP INDEX fk_group_teachers_45_idx;
DROP INDEX fk_group_members_44_idx;
DROP INDEX fk_group_members_43_idx;
DROP INDEX fk_group_announcements_42_idx;
DROP INDEX fk_courses_41_idx;
DROP INDEX fk_courses_40_idx;
DROP INDEX fk_courses_39_idx;
DROP INDEX fk_course_teachers_38_idx;
DROP INDEX fk_course_teachers_37_idx;
DROP INDEX fk_course_favorites_36_idx;
DROP INDEX fk_course_enrollments_35_idx;
DROP INDEX fk_course_enrollments_34_idx;
DROP INDEX fk_course_enrollments_33_idx;
DROP INDEX fk_broadcast_campaigns_32_idx;
DROP INDEX fk_bonus_transactions_31_idx;
DROP INDEX fk_bonus_transactions_30_idx;
DROP INDEX fk_bonus_transactions_29_idx;
DROP INDEX fk_bonus_rules_28_idx;
DROP INDEX fk_bonus_redemptions_27_idx;
DROP INDEX fk_bonus_offers_26_idx;
DROP INDEX fk_attempt_score_revisions_25_idx;
DROP INDEX fk_attempt_score_revisions_24_idx;
DROP INDEX fk_attempt_questions_23_idx;
DROP INDEX fk_attempt_questions_22_idx;
DROP INDEX fk_assets_21_idx;
DROP INDEX fk_asset_aliases_20_idx;
DROP INDEX fk_announcement_assets_19_idx;
DROP INDEX fk_ai_usage_ledger_18_idx;
DROP INDEX fk_ai_requests_17_idx;
DROP INDEX fk_ai_requests_16_idx;
DROP INDEX fk_ai_requests_15_idx;
DROP INDEX fk_ai_request_reservations_14_idx;
DROP INDEX fk_ai_messages_13_idx;
DROP INDEX fk_ai_limit_policies_12_idx;
DROP INDEX fk_ai_limit_policies_11_idx;
DROP INDEX fk_ai_limit_policies_10_idx;
DROP INDEX fk_ai_limit_policies_9_idx;
DROP INDEX fk_ai_credit_grants_8_idx;
DROP INDEX fk_ai_credit_grants_7_idx;
DROP INDEX fk_ai_conversations_6_idx;
DROP INDEX fk_ai_conversations_5_idx;
DROP INDEX fk_ai_analyses_4_idx;
DROP INDEX fk_ai_analyses_3_idx;
DROP INDEX fk_ai_analyses_2_idx;
DROP INDEX fk_achievements_1_idx;
DROP INDEX idempotency_expiry_idx;
DROP INDEX learning_activity_user_idx;
DROP INDEX jobs_lease_idx;
DROP INDEX jobs_claim_idx;
DROP INDEX delivery_pending_idx;
DROP INDEX notifications_inbox_idx;
DROP INDEX bonus_ledger_balance_idx;
DROP INDEX ai_analyses_latest_idx;
DROP INDEX ai_messages_history_idx;
DROP INDEX attempts_one_open_idx;
DROP INDEX attempts_user_history_idx;
DROP INDEX questions_subject_idx;
DROP INDEX questions_filter_idx;
DROP INDEX course_enrollments_user_idx;
DROP INDEX group_announcements_feed_idx;
DROP INDEX group_members_active_idx;
DELETE FROM roles WHERE code IN ('owner', 'admin', 'teacher', 'student');
ALTER TABLE audit_events DROP COLUMN entity_id;
ALTER TABLE audit_events DROP COLUMN entity_type;
DROP TRIGGER score_revisions_append_only ON attempt_score_revisions;
DROP TRIGGER ai_usage_append_only ON ai_usage_ledger;
DROP TRIGGER bonus_transactions_append_only ON bonus_transactions;
DROP TRIGGER test_questions_guard ON test_questions;
DROP TRIGGER tests_guard ON tests;
DROP TRIGGER question_topics_guard ON question_topics;
DROP TRIGGER question_assets_guard ON question_assets;
DROP TRIGGER question_keys_guard ON question_answer_keys;
DROP TRIGGER question_matching_guard ON question_matching_items;
DROP TRIGGER question_options_guard ON question_options;
DROP TRIGGER questions_guard ON questions;
DROP FUNCTION forbid_ledger_rewrite();
DROP FUNCTION guard_test();
DROP FUNCTION guard_test_question();
DROP FUNCTION guard_question();
DROP FUNCTION guard_question_child();
DROP FUNCTION assert_question_draft(BIGINT);
DROP FUNCTION can_access_module(BIGINT, BIGINT, TIMESTAMPTZ);
  `);
};
