import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";
import { DbClient } from "../db.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("constructor", () => {
    it("forUser forwards the caller JWT without requiring the system secret", async () => {
      delete process.env.JWT_SECRET;
      const userDb = DbClient.forUser("user-jwt");
      ctx.mockOk([]);

      await userDb.listDocuments("p1");

      const headers = ctx.fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer user-jwt");
    });

    it("forSystem mints a postgres-role JWT", async () => {
      const systemDb = DbClient.forSystem();
      ctx.mockOk([]);

      await systemDb.listDocuments("p1");

      const headers = ctx.fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      const payload = JSON.parse(Buffer.from(headers.Authorization.split(".")[1], "base64url").toString());
      expect(payload.role).toBe("postgres");
      expect(payload.sub).toBeUndefined();
    });

    it("mints a project-admin JWT for trusted InsForge Storage calls", () => {
      const systemDb = DbClient.forSystem();
      const payload = JSON.parse(
        Buffer.from(systemDb.storageToken.split(".")[1]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;

      expect(payload).toMatchObject({
        sub: "novel-vibe-system",
        email: "system@novel-vibe.local",
        role: "project_admin",
        iss: "insforge",
      });
    });

    it("throws if JWT_SECRET is not set", () => {
      delete process.env.JWT_SECRET;
      expect(() => DbClient.forSystem()).toThrow("JWT_SECRET");
    });

    it("uses custom pgUrl and apiUrl when provided via options", async () => {
      const customDb = DbClient.forSystem({
        pgUrl: "http://custom:9999",
        apiUrl: "http://custom-api:8888",
      });
      ctx.mockOk([]);
      await customDb.listDocuments("p1");
      expect(ctx.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("http://custom:9999"),
        expect.anything(),
      );
    });

    it("passes a Bearer token in Authorization header", async () => {
      ctx.mockOk([]);
      await ctx.db.listDocuments("p1");
      const headers = ctx.fetchMock.mock.calls[0][1]?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toMatch(/^Bearer /);
    });
  });
