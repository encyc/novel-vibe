import { DbClient } from "../lib/db.js";
import {
  ModelResolver,
  isOpenCodeDynamicModelsEnabled,
} from "./model-resolver.js";
import { RuntimeModelHealthService } from "./health-service.js";
import { createLogger } from "../lib/logger.js";

let systemModelResolver: ModelResolver | undefined;
let systemModelHealthService: RuntimeModelHealthService | undefined;

export function getSystemModelResolver(): ModelResolver {
  if (!systemModelResolver) {
    systemModelResolver = new ModelResolver({
      repository: DbClient.forSystem(),
      dynamicEnabled: isOpenCodeDynamicModelsEnabled(),
      ttlMs: 60_000,
    });
  }
  return systemModelResolver;
}

export function getSystemModelHealthService(): RuntimeModelHealthService {
  if (!systemModelHealthService) {
    systemModelHealthService = new RuntimeModelHealthService({
      repository: DbClient.forSystem(),
      resolver: getSystemModelResolver(),
      recipient: process.env.SMTP_EMAIL ?? null,
      logger: createLogger("model-runtime-health"),
    });
  }
  return systemModelHealthService;
}
