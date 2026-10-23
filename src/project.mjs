// Project modules are trusted executable code selected by the operator, never
// discovered from the candidate checkout or a release journal.
export function requireProject(project) {
  if (
    project?.schemaVersion !== 1 ||
    typeof project.checksDescription !== "string" ||
    !project.checksDescription.trim() ||
    typeof project.uiScope !== "string" ||
    !project.uiScope.trim() ||
    [
      "installValidation",
      "checkSource",
      "evaluateUI",
      "revalidateUI",
      "installBuild",
    ].some((name) => typeof project[name] !== "function")
  )
    throw new Error(
      "Release validation requires a trusted version-1 project adapter",
    );
  return project;
}
