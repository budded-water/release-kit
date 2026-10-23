// A project label must select one designated runner, not a generic runner class.
export function dedicatedRunnerLabel(value) {
  return (
    typeof value === "string" &&
    /^[-A-Za-z0-9_]{1,100}$/.test(value) &&
    !/^(self-hosted|macos|linux|windows|arm64|x64|x86)$/i.test(value) &&
    !/^(ubuntu|windows|macos)-/i.test(value)
  );
}
