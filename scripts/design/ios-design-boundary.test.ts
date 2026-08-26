import { describe, expect, test } from "bun:test";
import {
  findDuplicatePrimitiveDeclarations,
  findPageBoundaryViolations,
  findIosDesignBoundaryViolations,
  IOS_DESIGN_TRANSITIONAL_ALLOWLIST,
  readIosDesignSources,
  type IosDesignSource,
} from "./ios-design-boundary";

describe("iOS design boundary", () => {
  test("keeps the checked-in Theme and non-Calendar Settings graph closed", () => {
    expect(findIosDesignBoundaryViolations(readIosDesignSources())).toEqual([]);
  });

  test("rejects duplicate canonical primitive declarations", () => {
    const sources: IosDesignSource[] = [
      {
        path: "ios/App/Settings/Components/DesignControls.swift",
        source: "struct DesignField {}\nstruct DesignField {}",
      },
    ];
    expect(findDuplicatePrimitiveDeclarations(sources).join("\n")).toContain("DesignField: duplicate primitive declarations");
    expect(findDuplicatePrimitiveDeclarations([
      { path: "ios/App/Settings/Components/RowToggle.swift", source: "struct RowToggle {}" },
    ]).join("\n")).toContain("RowToggle must delegate to DesignToggleRow");
  });

  test("rejects raw controls, hardcoded families, and page-local visual constants", () => {
    expect(findPageBoundaryViolations([
      {
        path: "ios/App/Settings/FutureScreen.swift",
        source: "TextField(\"Name\", text: $name)\nprivate let cardWidth: CGFloat = 320",
      },
      {
        path: "ios/App/Theme/FutureTheme.swift",
        source: "Font.custom(\"DM Sans\", size: 15)",
      },
    ]).join("\n")).toContain("raw visual control");
    expect(findPageBoundaryViolations([
      { path: "ios/App/Theme/FutureTheme.swift", source: "Font.custom(\"DM Sans\", size: 15)" },
    ]).join("\n")).toContain("hardcoded font family");
    expect(findPageBoundaryViolations([
      { path: "ios/App/Settings/FutureScreen.swift", source: "Button(\"Save\") {}\n.font(Typo.ui(TypeScale.base))" },
    ]).join("\n")).toContain("raw styled Button");
    expect(findPageBoundaryViolations([
      { path: "ios/App/Settings/FutureScreen.swift", source: "private let cardWidth: CGFloat = 320" },
    ]).join("\n")).toContain("page-local visual constant");
  });

  test("does not turn product exclusions into migration exceptions", () => {
    expect(findPageBoundaryViolations([
      {
        path: "ios/App/Settings/Calendar/CalendarScreen.swift",
        source: "TextField(\"Calendar\", text: $text)",
      },
      {
        path: "ios/App/Settings/Voice/VoiceRowView.swift",
        source: "Button(\"Play\") {}\n.buttonStyle(.plain)",
      },
    ])).toEqual([]);
    expect(IOS_DESIGN_TRANSITIONAL_ALLOWLIST.every((entry) => entry.path.includes("/") && !entry.path.endsWith("/"))).toBe(true);
  });
});
