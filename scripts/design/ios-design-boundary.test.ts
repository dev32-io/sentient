import { describe, expect, test } from "bun:test";
import {
  findDuplicatePrimitiveDeclarations,
  findPageBoundaryViolations,
  findIosDesignBoundaryViolations,
  IOS_DESIGN_FOUNDATION_PATHS,
  IOS_DESIGN_TRANSITIONAL_ALLOWLIST,
  readIosDesignSources,
  type IosDesignSource,
} from "./ios-design-boundary";

describe("iOS design boundary", () => {
  test("keeps the checked-in Theme and non-Calendar Settings graph closed", () => {
    expect(findIosDesignBoundaryViolations(readIosDesignSources())).toEqual([]);
  });

  test("exempts only the exact split foundation modules", () => {
    expect([...IOS_DESIGN_FOUNDATION_PATHS].sort()).toEqual([
      "ios/App/Settings/Components/DesignBadgedIconButton.swift",
      "ios/App/Settings/Components/DesignButtons.swift",
      "ios/App/Settings/Components/DesignComposites.swift",
      "ios/App/Settings/Components/DesignControls.swift",
      "ios/App/Settings/Components/DesignIdentityControls.swift",
      "ios/App/Settings/Components/DesignRangeControls.swift",
      "ios/App/Settings/Components/DesignSelectionControls.swift",
      "ios/App/Settings/Components/DesignTextFields.swift",
      "ios/App/Settings/Components/UpdateFooter.swift",
      "ios/App/Theme/Colors.swift",
      "ios/App/Theme/DesignCanvasKernel.swift",
      "ios/App/Theme/DesignMaterials.swift",
      "ios/App/Theme/DesignSurfaces.swift",
      "ios/App/Theme/DesignV2.swift",
      "ios/App/Theme/Tokens.swift",
      "ios/App/Theme/Typo.swift",
    ]);

    expect(findPageBoundaryViolations([
      {
        path: "ios/App/Settings/Components/FutureControl.swift",
        source: "TextField(\"Name\", text: $name)",
      },
    ]).join("\n")).toContain("raw visual control");

    expect(findPageBoundaryViolations([
      {
        path: "ios/App/Theme/DesignCanvasKernelPreview.swift",
        source: "let cornerRadius: CGFloat = 7",
      },
    ]).join("\n")).toContain("page-local visual constant");
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

  test("rejects multiline hardcoded families at the custom call line", () => {
    const path = "ios/App/Theme/FutureTheme.swift";
    expect(findPageBoundaryViolations([
      {
        path,
        source: [
          "let body = Font",
          "    .custom(",
          "        \"DM Sans\",",
          "        size: 15",
          "    )",
        ].join("\n"),
      },
    ])).toEqual([
      `${path}:2: hardcoded font family; use the generated KMP typography role`,
    ]);

    expect(findPageBoundaryViolations([
      {
        path: "ios/App/Theme/DesignV2.swift",
        source: [
          "Font.custom(",
          "    DesignTypographyAdapter.uiMediumFace,",
          "    size: 14",
          ")",
        ].join("\n"),
      },
    ])).toEqual([]);
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
