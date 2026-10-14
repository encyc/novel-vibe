/**
 * Shared fixture kit for lib/db domain tests. Each test file calls
 * createDbTestContext() in beforeEach to get a fresh fetch mock, client,
 * and response helpers (was the shared closure of the old lib/db.test.ts).
 */

import { vi } from "vitest";
import { DbClient } from "../db.js";

export function createDbTestContext() {
  const fetchMock = vi.fn();
  global.fetch = fetchMock as any;

  process.env.JWT_SECRET = "test-secret-32-chars-minimum!!";
  process.env.POSTGREST_URL = "http://localhost:5430";
  process.env.INSFORGE_URL = "http://localhost:7130";
  fetchMock.mockReset();
  const db = DbClient.forSystem();

  function mockOk(data: unknown = [], headersExtra?: Record<string, string>) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(Array.isArray(data) ? data : [data]),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }

  function mockOkRaw(data: any) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }

  function mockError(status = 500, body = "internal error") {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status,
      json: () => Promise.resolve(null),
      text: () => Promise.resolve(body),
    });
  }

  return { fetchMock, db, mockOk, mockOkRaw, mockError };
}
