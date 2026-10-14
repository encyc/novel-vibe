BEGIN;

INSERT INTO novel.level_config (
  level, name, min_total_granted, multiplier, allowed_models, features
)
VALUES
  (0, '新用户', 0, 2.10, 'free', '[]'),
  (1, '普通会员', 100, 2.05, 'all', '["skills"]'),
  (2, '银卡会员', 500, 2.00, 'all', '["skills"]'),
  (3, '金卡会员', 2000, 1.95, 'all', '["skills","mcp"]'),
  (4, '铂金会员', 5000, 1.90, 'all', '["skills","mcp","advanced_models"]'),
  (5, '钻石会员', 10000, 1.85, 'all', '["skills","mcp","advanced_models","priority"]')
ON CONFLICT (level) DO UPDATE
SET multiplier = EXCLUDED.multiplier;

-- credit_balances denormalizes the active multiplier, so existing users must
-- move to the new ladder immediately rather than waiting for a future level
-- recalculation.
UPDATE novel.credit_balances AS balance
SET multiplier = config.multiplier
FROM novel.level_config AS config
WHERE balance.level = config.level
  AND balance.multiplier IS DISTINCT FROM config.multiplier;

COMMIT;
