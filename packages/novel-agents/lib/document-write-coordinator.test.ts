import { describe, expect, it } from "vitest";
import { DocumentWriteCoordinator, documentWriteKey } from "./document-write-coordinator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DocumentWriteCoordinator", () => {
  it("runs operations for the same document in order", async () => {
    const coordinator = new DocumentWriteCoordinator();
    const release = deferred();
    const order: string[] = [];

    const first = coordinator.run("p:a.md", async () => {
      order.push("first:start");
      await release.promise;
      order.push("first:end");
    });
    const second = coordinator.run("p:a.md", async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows different documents to run concurrently", async () => {
    const coordinator = new DocumentWriteCoordinator();
    const release = deferred();
    const order: string[] = [];

    const first = coordinator.run("p:a.md", async () => {
      order.push("a:start");
      await release.promise;
      order.push("a:end");
    });
    const second = coordinator.run("p:b.md", async () => {
      order.push("b");
    });

    await second;
    expect(order).toEqual(["a:start", "b"]);
    release.resolve();
    await first;
  });

  it("continues the queue after an operation rejects", async () => {
    const coordinator = new DocumentWriteCoordinator();
    const first = coordinator.run("p:a.md", async () => {
      throw new Error("write failed");
    });
    const second = coordinator.run("p:a.md", async () => "recovered");

    await expect(first).rejects.toThrow("write failed");
    await expect(second).resolves.toBe("recovered");
  });

  it("builds stable project-scoped keys", () => {
    expect(documentWriteKey("proj-1", "text/chapter-001.md"))
      .toBe("proj-1:text/chapter-001.md");
  });
});
