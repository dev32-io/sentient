import MobileData
import SwiftUI

struct CalendarTopBar: View {
    let canAdd: Bool
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding?
    let onBack: () -> Void
    let onAdd: () -> Void

    var body: some View {
        HStack(spacing: Space.sm) {
            DesignIconButton(systemName: "chevron.left", label: "Back", action: onBack)
                .accessibilityIdentifier("calendar-back")
            Text("Calendar")
                .font(Typo.ui(TypeScale.lg, .semibold))
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            DesignActionButton(
                title: "Add",
                state: canAdd ? .normal : .disabled,
                accessibilityId: "calendar-add",
                fillsWidth: false,
                action: onAdd
            )
            .opacity(canAdd ? CalendarSurfaceLayout.normalScale : CalendarSurfaceLayout.disabledOpacity)
            .accessibilityHint(canAdd ? "Creates a calendar event" : "Adding events is unavailable")
            .calendarAccessibilityFocus(openerFocus, equals: .addControl)
        }
        .padding(.horizontal, Space.sm)
        .frame(height: CalendarSurfaceLayout.topBarHeight)
        .background(DuskColors.bgElev)
        .overlay(alignment: .bottom) { Divider().overlay(DuskColors.lineSoft) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar-top-bar-58")
    }
}

struct CalendarHeading: View {
    let state: CalendarUiState
    let onToday: () -> Void
    let onPrevious: () -> Void
    let onNext: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: Space.md) {
            VStack(alignment: .leading, spacing: 5) {
                Text(CalendarSurfaceText.heading(for: state))
                    .font(Typo.display(DesignV2.Typography.display, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .minimumScaleFactor(0.72)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                Text(CalendarSurfaceText.subtitle(for: state))
                    .designText(.telemetry)
                    .foregroundStyle(DuskColors.ink3)
            }
            Spacer(minLength: 0)
            HStack(spacing: Space.sm) {
                CalendarNavigationButton(label: "Today", action: onToday)
                CalendarNavigationButton(label: "Previous period", systemImage: "chevron.left", action: onPrevious)
                CalendarNavigationButton(label: "Next period", systemImage: "chevron.right", action: onNext)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct CalendarNavigationButton: View {
    let label: String
    var systemImage: String?
    let action: () -> Void

    var body: some View {
        DesignCompactButton(
            accessibilityLabel: label,
            minimumWidth: CalendarSurfaceLayout.minimumTarget,
            minimumHeight: CalendarSurfaceLayout.minimumTarget,
            pressedScale: CalendarSurfaceLayout.pressedScale,
            action: action
        ) {
            Group {
                if let systemImage { Image(systemName: systemImage) } else { Text(label) }
            }
            .font(Typo.ui(TypeScale.xs, .medium))
            .foregroundStyle(DuskColors.ink2)
            .frame(minWidth: CalendarSurfaceLayout.minimumTarget,
                   minHeight: CalendarSurfaceLayout.minimumTarget)
            .background(DuskColors.bgSunk, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft))
        }
    }
}

struct CalendarStatusView: View {
    let state: CalendarUiState
    let onRetry: () -> Void

    var body: some View {
        Group {
            switch state.content {
            case .loading:
                DesignProgress(title: "Loading calendar…")
                    .statusStyle()
            case .unavailableOffline:
                retryStatus("This date range is not available offline.", icon: "wifi.slash")
            case .error:
                retryStatus(state.error?.userMessage ?? "Calendar is unavailable.", icon: "exclamationmark.triangle")
            case .empty, .content:
                if state.isOffline {
                    Label("Showing saved calendar data", systemImage: "wifi.slash").statusStyle()
                } else if state.isRefreshing {
                    Label("Refreshing calendar…", systemImage: "arrow.clockwise").statusStyle()
                } else if state.freshness == .stale {
                    Label("Calendar may be out of date", systemImage: "clock").statusStyle()
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(CalendarSurfaceText.stateAnnouncement(state) ?? "Calendar ready")
        .accessibilityIdentifier(CalendarSurfaceMapping.freshnessIdentifier(for: state))
    }

    private func retryStatus(_ message: String, icon: String) -> some View {
        HStack(spacing: Space.sm) {
            Label(message, systemImage: icon)
            Spacer(minLength: 0)
            DesignTextButton(
                title: "Retry",
                accessibilityId: "calendar-retry",
                action: onRetry
            )
        }
        .statusStyle()
    }
}

private extension View {
    func statusStyle() -> some View {
        self
            .font(Typo.ui(TypeScale.xs))
            .foregroundStyle(DuskColors.ink3)
            .padding(.horizontal, Space.md)
            .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.minimumTarget, alignment: .leading)
            .designPlate()
    }
}

struct FloatingViewBar: View {
    let selected: CalendarView
    let onSelect: (CalendarView) -> Void

    var body: some View {
        HStack(spacing: 3) {
            ForEach(CalendarView.allCases, id: \.self) { view in
                DesignSelectableButton(
                    accessibilityLabel: view.displayName,
                    state: selected == view ? .selected : .normal,
                    accessibilityId: "calendar-view-\(view.displayName.lowercased())",
                    minimumHeight: CalendarSurfaceLayout.viewControlHeight,
                    pressedScale: CalendarSurfaceLayout.pressedScale,
                    action: { onSelect(view) }
                ) {
                    Text(view.displayName)
                        .font(Typo.mono(TypeScale.xs))
                        .foregroundStyle(selected == view ? DuskColors.ink : DuskColors.ink3)
                        .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.viewControlHeight)
                        .background(selected == view ? DuskColors.bgSunk : .clear, in: Capsule())
                        .overlay(Capsule().stroke(selected == view ? DuskColors.line : .clear))
                }
            }
        }
        .padding(CalendarSurfaceLayout.floatingInnerPadding)
        .background(.ultraThinMaterial, in: Capsule())
        .background(DuskColors.paper.opacity(CalendarSurfaceLayout.floatingPaperOpacity), in: Capsule())
        .overlay(Capsule().stroke(DuskColors.line))
        .shadow(color: DuskColors.bg.opacity(CalendarSurfaceLayout.floatingShadowOpacity),
                radius: CalendarSurfaceLayout.floatingShadowRadius,
                y: CalendarSurfaceLayout.floatingShadowY)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Calendar view")
        .accessibilityIdentifier("calendar-floating-view-bar-46")
    }
}

private extension View {
    @ViewBuilder
    func calendarAccessibilityFocus(
        _ focus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding?,
        equals origin: CalendarOverlayOrigin
    ) -> some View {
        if let focus {
            accessibilityFocused(focus, equals: origin)
        } else {
            self
        }
    }
}

extension CalendarView {
    var displayName: String {
        switch self {
        case .day: "Day"
        case .week: "Week"
        case .month: "Month"
        case .year: "Year"
        }
    }
}
