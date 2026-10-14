// Minimal novel-side cut of the dsh submission policy: queue while generating
// (steering waits until the queue becomes server-authoritative).
export type SubmitGesture = "send" | "queue";
export function resolveSubmit(running: boolean): SubmitGesture {
  return running ? "queue" : "send";
}
