import { DbClient } from "../lib/db.js";
import { createContentStore } from "../lib/content-store-factory.js";
import { SkillRepository } from "./repository.js";
import { createConfiguredReviewGenerator } from "./reviewer.js";
import { SkillReviewService } from "./service.js";

export function createSkillReviewService(token: string): SkillReviewService {
  return new SkillReviewService({
    repository: new SkillRepository(DbClient.forUser(token)),
    storage: createContentStore({ mode: "user", token, bucket: "skills" }),
    generator: createConfiguredReviewGenerator(),
  });
}
