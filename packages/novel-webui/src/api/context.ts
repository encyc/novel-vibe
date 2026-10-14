/** Minimal request plumbing shared by the api domain modules. */
export interface ApiRequestContext {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}
