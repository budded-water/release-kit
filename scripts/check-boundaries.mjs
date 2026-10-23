import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

for (const directory of ["src", "bin"]) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".mjs")) continue;
    const path = join(directory, file);
    const source = await readFile(path, "utf8");
    execFileSync(process.execPath, ["--check", path]);
    assert(
      !/go-global|goglobal|GOGLOBAL|GO_GLOBAL|\/Users\//.test(source),
      `Consumer-specific data in ${path}`,
    );
    assert(
      !/from ['"]\.\.\//.test(source) || directory === "bin",
      `Runtime imports outside package in ${path}`,
    );
  }
}
console.log("Verified runtime syntax and project boundary.");
