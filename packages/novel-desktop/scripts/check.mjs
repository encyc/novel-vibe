import { spawnSync } from "node:child_process";

const manifest = ["--manifest-path", "src-tauri/Cargo.toml"];
const steps = [
  ["cargo", ["fmt", ...manifest, "--", "--check"]],
  ["cargo", ["clippy", ...manifest, "--all-targets", "--", "-D", "warnings"]],
  ["cargo", ["test", ...manifest]],
];
for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
