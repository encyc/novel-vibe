export {};

declare global {
  interface Window {
    novelDesktop?: {
      readonly apiVersion: 1;
      getRuntimeInfo(): Promise<{
        platform: "macos" | "windows";
        appVersion: string;
        capabilities: string[];
      }>;
    };
  }
}
