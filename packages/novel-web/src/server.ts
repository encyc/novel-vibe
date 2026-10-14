import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createHandler } from "./routes.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const log = createLogger("web");

export const server = createServer(createHandler(config));

if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, () => {
    log.info(`listening on http://localhost:${config.port}`);
  });
}
