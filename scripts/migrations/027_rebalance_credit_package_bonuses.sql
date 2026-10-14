BEGIN;

UPDATE novel.credit_packages
SET bonus_credits = CASE name
  WHEN '尝鲜包' THEN 0
  WHEN '基础包' THEN 20
  WHEN '日常包' THEN 75
  WHEN '进阶包' THEN 200
  ELSE bonus_credits
END,
updated_at = now()
WHERE name IN ('尝鲜包', '基础包', '日常包', '进阶包');

COMMIT;
