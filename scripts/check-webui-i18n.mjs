import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"]);
const PACKAGEABLE_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, ...STYLE_EXTENSIONS]);
const ALLOWED_PRODUCTION_FILES = new Set(["i18n/locales/zh-CN.ts"]);

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function displayPath(filePath, repositoryRoot) {
  return normalizePath(path.relative(repositoryRoot, filePath));
}

function isTestScript(relativePath, extension) {
  if (!SCRIPT_EXTENSIONS.has(extension)) return false;
  return relativePath.split("/").includes("__tests__")
    || /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/iu.test(relativePath);
}

export async function scanSourceTree({ sourceRoot, repositoryRoot }) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteRepositoryRoot = path.resolve(repositoryRoot);
  const hardcodedCopy = [];
  const symlinks = [];

  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = normalizePath(path.relative(absoluteSourceRoot, entryPath));
      if (entry.isSymbolicLink()) {
        symlinks.push(displayPath(entryPath, absoluteRepositoryRoot));
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!PACKAGEABLE_EXTENSIONS.has(extension)
        || ALLOWED_PRODUCTION_FILES.has(relativePath)
        || isTestScript(relativePath, extension)) {
        continue;
      }
      const source = await readFile(entryPath, "utf8");
      source.split("\n").forEach((line, index) => {
        if (/[\u3400-\u9fff]/u.test(line)) {
          hardcodedCopy.push(`${displayPath(entryPath, absoluteRepositoryRoot)}:${index + 1}`);
        }
      });
    }
  }

  const sourceRootStats = await lstat(absoluteSourceRoot);
  if (sourceRootStats.isSymbolicLink()) {
    symlinks.push(displayPath(absoluteSourceRoot, absoluteRepositoryRoot));
  } else {
    await visit(absoluteSourceRoot);
  }

  return { hardcodedCopy, symlinks };
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = path.join(repositoryRoot, "packages/novel-webui/src");
  const result = await scanSourceTree({ repositoryRoot, sourceRoot });
  const errors = [];
  if (result.hardcodedCopy.length > 0) {
    errors.push(`Hardcoded Chinese UI copy:\n${result.hardcodedCopy.join("\n")}`);
  }
  if (result.symlinks.length > 0) {
    errors.push(`Symlinks are not allowed in WebUI source:\n${result.symlinks.join("\n")}`);
  }
  if (errors.length > 0) {
    console.error(errors.join("\n\n"));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
