// Project modules are trusted executable code selected by the operator, never
// discovered from the candidate checkout or a release journal.
export function requireProject(project) {
  if (
    project?.schemaVersion !== 1 ||
    typeof project.checksDescription !== "string" ||
    !project.checksDescription.trim() ||
    (project.sourceValidationPolicy !== undefined &&
      (typeof project.sourceValidationPolicy !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(
          project.sourceValidationPolicy,
        ))) ||
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
