import { jsonResponse } from "../http.js";
import type { RouteContext } from "../http.js";

export async function byokConfigGet({ byokService, res }: RouteContext) {
  jsonResponse(res, await byokService().config());
}
