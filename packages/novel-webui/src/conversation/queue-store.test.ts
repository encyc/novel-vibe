import { beforeEach, describe, expect, it } from "vitest";
import { createSessionQueue } from "./queue-store";

beforeEach(() => window.localStorage.clear());

describe("createSessionQueue", () => {
  it("enqueues, edits, removes and shifts fifo", () => {
    const queue = createSessionQueue("s1");
    queue.enqueue("第一句");
    queue.enqueue("第二句");
    queue.editAt(1, "改过的第二句");
    expect(queue.items()).toEqual(["第一句", "改过的第二句"]);
    queue.removeAt(0);
    expect(queue.shift()).toBe("改过的第二句");
    expect(queue.items()).toEqual([]);
  });

  it("persists across recreation", () => {
    createSessionQueue("s2").enqueue("存活");
    expect(createSessionQueue("s2").items()).toEqual(["存活"]);
  });
});
