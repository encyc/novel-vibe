import { describe, expect, it, vi } from "vitest";
import { SessionTelemetry } from "./observability.js";

describe("SessionTelemetry", () => {
  it("redacts prompt, message, content, and token fields before logging", () => {
    const write = vi.fn();
    const telemetry = new SessionTelemetry(write);

    telemetry.info("session.chat", {
      sessionId: "s1",
      turnId: "t1",
      stage: "persist",
      prompt: "secret prompt",
      message: "secret message",
      content: "secret content",
      inputTokens: 123,
      nested: { documentText: "secret", errorCode: "E1" },
    });

    const logged = JSON.parse(write.mock.calls[0][0]);
    expect(logged).toMatchObject({
      level: "info",
      event: "session.chat",
      sessionId: "s1",
      turnId: "t1",
      stage: "persist",
    });
    expect(JSON.stringify(logged)).not.toContain("secret");
    expect(JSON.stringify(logged)).not.toContain("123");
  });

  it("emits errors and counters without sensitive payloads", () => {
    const write = vi.fn();
    const telemetry = new SessionTelemetry(write);

    telemetry.error("session.failure", { sessionId: "s1", errorCode: "SESSION_BUSY" });
    telemetry.increment("session.persistence_failure");

    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
      level: "error",
      errorCode: "SESSION_BUSY",
    });
    expect(JSON.parse(write.mock.calls[1][0])).toMatchObject({
      level: "metric",
      metric: "session.persistence_failure",
      value: 1,
    });
  });
});
