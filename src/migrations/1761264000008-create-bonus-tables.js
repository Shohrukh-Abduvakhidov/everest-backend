export const up = pgm => {
  pgm.sql(`
-- I Бонусы: Баланс — сумма операций журнала, поле balance не хранится
CREATE TABLE bonus_accounts (
id UUID PRIMARY KEY,
user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- I Бонусы: Настраиваемые правила; значения не зашиты в код
CREATE TABLE bonus_rules (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, event_type VARCHAR(32) NOT NULL,
points BIGINT NOT NULL CHECK (points >= 0), conditions JSONB NOT NULL DEFAULT '{}',
is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- I Бонусы: Неизменяемый журнал начислений, списаний и компенсаций
CREATE TABLE bonus_transactions (
id UUID PRIMARY KEY,
account_id UUID NOT NULL REFERENCES bonus_accounts(id) ON DELETE RESTRICT, delta BIGINT NOT NULL CHECK (delta <> 0),
rule_id UUID REFERENCES bonus_rules(id) ON DELETE RESTRICT, source_event_key TEXT NOT NULL,
operation VARCHAR(16) NOT NULL CHECK (operation IN ('earn','spend','refund','adjust')),
reverses_id UUID REFERENCES bonus_transactions(id) ON DELETE RESTRICT, performed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (account_id,source_event_key), CHECK (reverses_id IS NULL OR reverses_id <> id)
);

-- I Бонусы: Обмен бонусов на пакеты ИИ; скидки пока не активируем
CREATE TABLE bonus_offers (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, price_points BIGINT NOT NULL CHECK (price_points > 0),
ai_requests_count INTEGER NOT NULL CHECK (ai_requests_count > 0),
valid_days INTEGER CHECK (valid_days > 0), max_per_user_per_day INTEGER CHECK (max_per_user_per_day > 0),
is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- I Бонусы: Однократный обмен с фиксацией условий предложения
CREATE TABLE bonus_redemptions (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, offer_id UUID NOT NULL REFERENCES bonus_offers(id) ON DELETE RESTRICT,
transaction_id UUID NOT NULL UNIQUE REFERENCES bonus_transactions(id) ON DELETE RESTRICT, offer_snapshot JSONB NOT NULL,
idempotency_key TEXT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'completed'
CHECK (status IN ('completed','reversed')), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (user_id,idempotency_key), UNIQUE (id,user_id)
);

-- I Бонусы: Пакет запросов ИИ, полученный за бонусы
CREATE TABLE ai_credit_grants (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, redemption_id UUID NOT NULL UNIQUE,
total_requests INTEGER NOT NULL CHECK (total_requests > 0),
used_requests INTEGER NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
reserved_requests INTEGER NOT NULL DEFAULT 0 CHECK (reserved_requests >= 0),
granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
UNIQUE (id,user_id), FOREIGN KEY (redemption_id,user_id) REFERENCES bonus_redemptions(id,user_id) ON DELETE RESTRICT,
CHECK (used_requests + reserved_requests <= total_requests), CHECK (expires_at IS NULL OR expires_at > granted_at)
);
ALTER TABLE ai_requests ADD COLUMN credit_grant_id UUID;
ALTER TABLE ai_requests ADD CONSTRAINT ai_request_credit_owner_fk
FOREIGN KEY (credit_grant_id,user_id) REFERENCES ai_credit_grants(id,user_id) ON DELETE RESTRICT;

-- I Бонусы: Определения достижений
CREATE TABLE achievements (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
icon_asset_id UUID REFERENCES assets(id) ON DELETE RESTRICT, criteria JSONB NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- I Бонусы: Выданные достижения
CREATE TABLE user_achievements (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE RESTRICT,
awarded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, source_event_key TEXT NOT NULL,
PRIMARY KEY (user_id,achievement_id)
);
  `);
};

export const down = pgm => {
  pgm.sql(`
ALTER TABLE ai_requests DROP CONSTRAINT ai_request_credit_owner_fk;
ALTER TABLE ai_requests DROP COLUMN credit_grant_id;
DROP TABLE user_achievements;
DROP TABLE achievements;
DROP TABLE ai_credit_grants;
DROP TABLE bonus_redemptions;
DROP TABLE bonus_offers;
DROP TABLE bonus_transactions;
DROP TABLE bonus_rules;
DROP TABLE bonus_accounts;
  `);
};
