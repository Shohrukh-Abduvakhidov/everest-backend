// M13 (decisions.md 2026-11-25): group ranking.
// - group_ranking_settings: who of the students sees the ranking of a group. No row means the
//   default 'top10_self'. Staff always see the full ranking.
// - A partial index for the assignments that count for the ranking of a group, by close time.
// The ranking itself is computed on read (no table, no cache).
export const up = pgm => {
   pgm.sql(`
CREATE TABLE group_ranking_settings (
    group_id BIGINT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    visibility VARCHAR(16) NOT NULL DEFAULT 'top10_self'
        CHECK (visibility IN ('full', 'top10_self', 'staff_only')),
    updated_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX test_assignments_group_ranking_idx ON test_assignments (group_id, closes_at)
    WHERE counts_for_group_ranking;
   `)
}

export const down = pgm => {
   pgm.sql(`
DROP INDEX test_assignments_group_ranking_idx;
DROP TABLE group_ranking_settings;
   `)
}
