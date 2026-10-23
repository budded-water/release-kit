// Copy into a trusted consumer checkout and supply that project's real checks.
// This example only supports source validation; it cannot build or publish.
const unsupported = async () => {
  throw new Error(
    "Configure and review actual UI/build evidence adapters first",
  );
};
export default {
  repo: process.cwd(),
  project: {
    schemaVersion: 1,
    // Change this identity when installation/check semantics or inputs change.
    sourceValidationPolicy: "example/source-checks/v1",
    checksDescription: "npm run check",
    uiScope: "not-configured",
    installValidation: ({ command, root, env }) =>
      command("npm", ["ci"], { cwd: root, env, timeout: 900000 }),
    checkSource: ({ command, root, env }) =>
      command("npm", ["run", "check"], { cwd: root, env, timeout: 1800000 }),
    evaluateUI: unsupported,
    revalidateUI: unsupported,
    installBuild: unsupported,
  },
  platformAdapters: {},
};
