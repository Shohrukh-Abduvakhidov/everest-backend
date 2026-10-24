export const up = pgm => {
  pgm.sql(`
-- J Уведомления: Согласие на сообщения бота отдельно от Telegram-входа
CREATE TABLE telegram_connections (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, bot_id TEXT NOT NULL, chat_id BIGINT NOT NULL,
status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','disconnected')),
connected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, blocked_at TIMESTAMPTZ,
UNIQUE (bot_id,chat_id), UNIQUE (user_id,bot_id)
);

-- J Уведомления: Web Push подписки устройств
CREATE TABLE push_subscriptions (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, endpoint TEXT NOT NULL UNIQUE,
p256dh TEXT NOT NULL, auth_secret TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
revoked_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ
);

-- J Уведомления: Настройки по типу события и каналу
CREATE TABLE notification_preferences (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, event_code TEXT NOT NULL,
channel VARCHAR(16) NOT NULL CHECK (channel IN ('in_app','push','telegram')),
enabled BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id,event_code,channel)
);

-- J Уведомления: Шаблон, аудитория и время рассылки
CREATE TABLE broadcast_campaigns (
id UUID PRIMARY KEY,
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, title TEXT NOT NULL, content JSONB NOT NULL,
audience_filter JSONB NOT NULL, channels JSONB NOT NULL, timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Dushanbe',
scheduled_at TIMESTAMPTZ,
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','completed','cancelled','failed')),
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ
);

-- J Уведомления: Персональная запись уведомления; получатели кампании фиксируются
CREATE TABLE notifications (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, campaign_id UUID REFERENCES broadcast_campaigns(id) ON DELETE RESTRICT,
event_code TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, target_path TEXT,
dedupe_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TIMESTAMPTZ,
UNIQUE (user_id,dedupe_key)
);

-- J Уведомления: Одна запись на конкретное устройство/Telegram chat
CREATE TABLE notification_deliveries (
id UUID PRIMARY KEY,
notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE RESTRICT,
channel VARCHAR(16) NOT NULL CHECK (channel IN ('push','telegram')),
push_subscription_id UUID REFERENCES push_subscriptions(id) ON DELETE RESTRICT, telegram_connection_id UUID REFERENCES telegram_connections(id) ON DELETE RESTRICT,
destination_key TEXT NOT NULL, provider_message_id TEXT,
status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','unknown','cancelled')),
attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
next_attempt_at TIMESTAMPTZ, last_error_code TEXT, sent_at TIMESTAMPTZ,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (notification_id,channel,destination_key),
CHECK ((channel = 'push' AND push_subscription_id IS NOT NULL AND telegram_connection_id IS NULL)
OR (channel = 'telegram' AND telegram_connection_id IS NOT NULL AND push_subscription_id IS NULL))
);
  `);
};

export const down = pgm => {
  pgm.sql(`
DROP TABLE notification_deliveries;
DROP TABLE notifications;
DROP TABLE broadcast_campaigns;
DROP TABLE notification_preferences;
DROP TABLE push_subscriptions;
DROP TABLE telegram_connections;
  `);
};
