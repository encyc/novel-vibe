import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../scripts/migrations/018_agent_resources.sql", import.meta.url),
  "utf8",
);

describe("agent resource migration", () => {
  it("creates immutable resources and versions", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.agent_resources");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.agent_resource_versions");
    expect(sql).toContain("UNIQUE (resource_type, resource_key)");
    expect(sql).toContain("UNIQUE (resource_id, version_number)");
    expect(sql).toContain("storage_path TEXT NOT NULL UNIQUE");
  });

  it("publishes and rolls back through checked functions", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.publish_agent_resource_version");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.activate_agent_resource_version");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("active version must belong to the same resource");
  });

  it("does not grant mutation to browser roles", () => {
    expect(sql).toContain("REVOKE ALL ON public.agent_resources FROM anon, authenticated");
    expect(sql).toContain("REVOKE ALL ON public.agent_resource_versions FROM anon, authenticated");
  });
});
