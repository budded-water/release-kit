#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "../src/cli.mjs";

// Explicit executable configuration: never search candidate sources for plugins.
const args = process.argv.slice(2);
try {
  let options = {};
  if (args[0] === "--project") {
    if (!args[1])
      throw new Error("--project requires a trusted local module path");
    options = (await import(pathToFileURL(resolve(args[1])).href)).default;
    if (!options || typeof options !== "object" || !options.repo)
      throw new Error(
        "Project module must export { repo, project, platformAdapters }",
      );
    args.splice(0, 2);
  }
  process.exitCode = await main({ ...options, args });
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
