BEGIN;

DROP FUNCTION IF EXISTS novel.disable_dynamic_model(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP TABLE IF EXISTS novel.model_runtime_incidents;
DROP TABLE IF EXISTS novel.model_runtime_catalog;

COMMIT;
