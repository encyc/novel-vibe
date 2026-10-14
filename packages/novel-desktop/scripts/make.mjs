import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageRoot = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", packageRoot)));
const tauriConf = JSON.parse(
  readFileSync(new URL("src-tauri/tauri.conf.json", packageRoot)),
);
if (pkg.version !== tauriConf.version) {
  console.error(
    `version mismatch: package.json ${pkg.version} != src-tauri/tauri.conf.json ${tauriConf.version}`,
  );
  process.exit(1);
}

const platformBundles = { darwin: "dmg", win32: "nsis" };
const bundles = platformBundles[process.platform];
if (!bundles) {
  console.error(`desktop packaging is not supported on ${process.platform}`);
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const tauriConfigOverride = process.env.NOVEL_DESKTOP_TAURI_CONFIG;
const configArgs = tauriConfigOverride
  ? ["--config", tauriConfigOverride]
  : [];
const result = spawnSync(
  "npx",
  ["tauri", "build", "--bundles", bundles, ...configArgs, ...extraArgs],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
process.exit(result.status ?? 1);
