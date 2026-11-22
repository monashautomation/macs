import { describe, expect, it } from "vitest";
import { absoluteUrl, safeRedirectPath } from "@/lib/url";

describe("safeRedirectPath", () => {
  it.each(["//evil.test", "/\\evil.test", "https://evil.test", "javascript:alert(1)", "evil", "/\u0000x"])(
    "rejects %s",
    (input) => expect(safeRedirectPath(input)).toBe("/"),
  );
  it("keeps same-site paths", () => {
    expect(safeRedirectPath("/notes?x=1")).toBe("/notes?x=1");
  });
});

describe("absoluteUrl", () => {
  it("anchors on the configured app URL, never the request", () => {
    expect(absoluteUrl("/a", "https://app.monashautomation.com")).toBe("https://app.monashautomation.com/a");
    expect(absoluteUrl("//evil.test", "https://app.monashautomation.com")).toBe(
      "https://app.monashautomation.com/",
    );
  });
});
