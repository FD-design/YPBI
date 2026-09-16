import { describe, expect, test } from "bun:test";
import { resolveUiVersion, withUiVersion } from "./uiVersion";

describe("UI version switch", () => {
  test("uses v1.3 by default for the unified platform UI", () => {
    expect(resolveUiVersion("", undefined)).toBe("v13");
  });

  test("allows one project-level environment fallback", () => {
    expect(resolveUiVersion("", "classic")).toBe("classic");
    expect(resolveUiVersion("", "v13")).toBe("v13");
  });

  test("allows an explicit QA and rollback override", () => {
    expect(resolveUiVersion("?ui=classic", "v13")).toBe("classic");
    expect(resolveUiVersion("?ui=v13", "classic")).toBe("v13");
  });

  test("preserves existing navigation parameters", () => {
    expect(withUiVersion("/?workspace=cards", "v13")).toBe("/?workspace=cards&ui=v13");
  });
});
