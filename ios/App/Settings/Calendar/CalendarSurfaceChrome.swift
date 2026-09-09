import MobileData
import SwiftUI

struct CalendarTopBar: View {
    let canAdd: Bool
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding?
    let onBack: () -> Void
    let onAdd: () -> Void
    var showsAdd = true

    var body: some View {
        DesignPageHeader(title: "Calendar", backAccessibilityId: "calendar-back", onBack: onBack) {
            if showsAdd {
                DesignActionButton(
                    title: "Add",
                    state: canAdd ? .normal : .disabled,
                    accessibilityId: "calendar-add",
                    fillsWidth: false,
                    action: onAdd
                )
                .accessibilityHint(canAdd ? "Creates a calendar event" : "Adding events is unavailable")
                .calendarAccessibilityFocus(openerFocus, equals: .addControl)
            }
        }
        .accessibilityIdentifier("calendar-top-bar-58")
    }
}

struct CalendarHeading: View {
    let state: CalendarUiState
    let onToday: () -> Void
    let onPrevious: () -> Void
    let onNext: () -> Void
    var onFilters: (() -> Void)? = nil
    var filterFocus: AccessibilityFocusState<Bool>.Binding? = nil
    var onAdd: (() -> Void)? = nil
    var openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding? = nil
    var browsedMonth: CalendarViewportMonth? = nil
    var browsedDate: CalendarViewportDate? = nil
    var adjacentProjection: CalendarExperienceProjection? = nil
    @Environment(\.dynamicTypeSize) private var dynamicType

    var body: some View {
        // One semantic instance of title and each action. Normal phones keep
        // the title and < Today > on one row; accessibility text reflows.
        CalendarPeriodRow(accessibilitySize: dynamicType.isAccessibilitySize) {
            CalendarHeadingTitle(title: title)
            HStack(spacing: 0) {
                DesignIconButton(systemName: "chevron.backward", label: "Previous period", action: onPrevious)
                    .accessibilityIdentifier("calendar-previous")
                DesignActionButton(title: "Today", role: .quiet, fillsWidth: false, action: onToday)
                    .accessibilityIdentifier("calendar-today")
                DesignIconButton(systemName: "chevron.forward", label: "Next period", action: onNext)
                    .accessibilityIdentifier("calendar-next")
            }
        }
        .accessibilityElement(children: .contain)
    }
    private var title: String {
        if state.view == .day || state.view == .week {
            return CalendarSurfaceText.adjacentHeading(
                view: state.view, anchorDate: browsedDate?.date ?? state.anchorDate,
                projection: adjacentProjection, locale: state.locale
            )
        }
        guard let browsedMonth, state.view == .month || state.view == .year else {
            return CalendarSurfaceText.heading(for: state)
        }
        if state.view == .year { return String(browsedMonth.year) }
        let calendar = CalendarCivilMonth.calendar(state.locale)
        return "\(calendar.standaloneMonthSymbols[Int(browsedMonth.month) - 1]) \(browsedMonth.year)"
    }
}

private struct CalendarHeadingTitle: View {
    let title: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(title)
            .font(Typo.display(TypeScale.lg, .regular))
            .foregroundStyle(DuskColors.ink)
            .fixedSize(horizontal: false, vertical: true)
            // The title itself is the period identity. No data revision or
            // scroll sample can restart this incoming-only fade, and Text
            // remains the single semantic heading while its value updates.
            .keyframeAnimator(initialValue: 1.0, trigger: title) { content, opacity in
                content.opacity(reduceMotion ? 1 : opacity)
            } keyframes: { _ in
                MoveKeyframe(0)
                LinearKeyframe(1, duration: Motion.normal)
            }
            .transaction { transaction in
                if reduceMotion {
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
            }
            .accessibilityAddTraits(.isHeader)
    }
}

struct CalendarPeriodRow: Layout {
    let accessibilitySize: Bool
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let width = proposal.width ?? 320
        let navigation = subviews[1].sizeThatFits(.unspecified)
        let available = accessibilitySize ? width : max(0, width - navigation.width - Space.xs)
        let title = subviews[0].sizeThatFits(.init(width: available, height: nil))
        return CGSize(width: width, height: accessibilitySize ? title.height + Space.xs + navigation.height : max(title.height, navigation.height))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let navigation = subviews[1].sizeThatFits(.unspecified)
        if accessibilitySize {
            subviews[0].place(at: bounds.origin, anchor: .topLeading, proposal: .init(width: bounds.width, height: nil))
            subviews[1].place(at: CGPoint(x: bounds.midX, y: bounds.maxY), anchor: .bottom, proposal: .init(navigation))
        } else {
            let width = max(0, bounds.width - navigation.width - Space.xs)
            // SwiftUI supplies the physical RTL mirror for these logical placements.
            let titleX = bounds.minX
            let navX = bounds.maxX - navigation.width
            subviews[0].place(at: CGPoint(x: titleX, y: bounds.midY), anchor: .leading, proposal: .init(width: width, height: nil))
            subviews[1].place(at: CGPoint(x: navX, y: bounds.midY), anchor: .leading, proposal: .init(navigation))
        }
    }
}

private extension View {
    @ViewBuilder
    func calendarFilterFocus(_ focus: AccessibilityFocusState<Bool>.Binding?) -> some View {
        if let focus { accessibilityFocused(focus) } else { self }
    }
}

struct CalendarStatusView: View {
    let state: CalendarUiState
    let onRetry: () -> Void

    var body: some View {
        Group {
            if let error = state.error, error.kind == .authorization || error.kind == .forbidden {
                retryStatus(error.userMessage, icon: "exclamationmark.triangle")
            } else {
                status
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(CalendarSurfaceText.stateAnnouncement(state) ?? "Calendar status")
        .accessibilityIdentifier(CalendarSurfaceMapping.freshnessIdentifier(for: state))
    }

    @ViewBuilder private var status: some View {
        switch state.content {
        case .loading:
            EmptyView()
        case .unavailableOffline:
            retryStatus("This date range is not available offline.", icon: "wifi.slash")
        case .error:
            retryStatus(state.error?.userMessage ?? "Calendar is unavailable.", icon: "exclamationmark.triangle")
        case .empty, .content:
            if state.isOffline {
                Label("Showing saved calendar data", systemImage: "wifi.slash").statusStyle()
            } else if state.freshness == .stale {
                Label("Calendar may be out of date", systemImage: "clock").statusStyle()
            }
        }
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
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink2)
            .padding(.horizontal, Space.md)
            .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.minimumTarget, alignment: .leading)
            .padding(.vertical, Space.xs)
            .background(DuskColors.bgElev)
    }
}

struct FloatingViewBar: View {
    let selected: CalendarView
    let onSelect: (CalendarView) -> Void
    var onFilters: (() -> Void)? = nil
    var filterFocus: AccessibilityFocusState<Bool>.Binding? = nil
    var activeFilterCount: Int = 0
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.layoutDirection) private var direction

    private var options: [(value: CalendarView, label: String)] {
        CalendarView.allCases.map { (value: $0, label: $0.displayName) }
    }

    var body: some View {
        controls
            // Layout only: the two native controls own their own surfaces and
            // hit regions. The gap has no background or interaction shape.
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Calendar controls")
    }

    @ViewBuilder
    private var controls: some View {
        if let onFilters {
            CalendarFloatingControlsLayout(direction: direction) {
                DesignBadgedIconButton(
                    systemName: "line.3.horizontal.decrease",
                    label: "Calendar filters",
                    count: activeFilterCount,
                    accessibilityId: "calendar-open-filters",
                    countAccessibilityValue: activeFilterCount > 0
                        ? "\(activeFilterCount) active filters"
                        : "No active filters",
                    action: onFilters
                )
                .calendarFilterFocus(filterFocus)
                .environment(\.layoutDirection, direction)
                modeControl
                    .environment(\.layoutDirection, direction)
            }
            // This Layout computes physical LTR/RTL coordinates itself. Do
            // not let SwiftUI mirror its placements a second time. Restore the
            // user's direction inside each native control, not on the layout.
            .environment(\.layoutDirection, .leftToRight)
        } else {
            modeControl
        }
    }

    @ViewBuilder
    private var modeControl: some View {
        // A semantic branch, not ViewThatFits' duplicate focus planes.
        if dynamicType.isAccessibilitySize {
            Menu {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    Button {
                        onSelect(option.value)
                    } label: {
                        if option.value == selected {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                    .accessibilityIdentifier("calendar-view-\(option.value.displayName.lowercased())")
                }
            } label: {
                DesignMenuTriggerLabel(
                    currentLabel: selected.displayName,
                    isEnabled: true,
                    width: .intrinsic
                )
            }
            .accessibilityLabel("Calendar view")
            .accessibilityValue(selected.displayName)
            .accessibilityIdentifier("calendar-floating-view-bar-46")
        } else {
            // Full labels and native targets; the existing picker reflows
            // when its natural width exceeds the available row.
            DesignSegmentedPicker(title: "Calendar view", options: options,
                                  selection: Binding(get: { selected }, set: onSelect),
                                  accessibilityId: "calendar-floating-view-bar-46",
                                  optionAccessibilityId: { "calendar-view-\($0.displayName.lowercased())" },
                                  reflowsToFit: true,
                                  segmentHorizontalPadding: Space.sm)
        }
    }
}

/// Bottom-leading action and bottom-trailing picker, with intrinsic surfaces
/// rather than a stretched rail. When necessary, the picker reflows below the
/// filter; there is still only one instance of each native control.
private struct CalendarFloatingControlsLayout: Layout {
    let direction: LayoutDirection

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let filter = subviews[0].sizeThatFits(.unspecified)
        let naturalMode = subviews[1].sizeThatFits(.unspecified)
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil }
            ?? filter.width + Space.md + naturalMode.width
        let wraps = filter.width + Space.md + naturalMode.width > width
        let mode = subviews[1].sizeThatFits(.init(width: min(width, naturalMode.width), height: nil))
        return CGSize(width: width, height: wraps
                      ? filter.height + Space.sm + mode.height : max(filter.height, mode.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let filter = subviews[0].sizeThatFits(.unspecified)
        let naturalMode = subviews[1].sizeThatFits(.unspecified)
        let wraps = filter.width + Space.md + naturalMode.width > bounds.width
        let mode = subviews[1].sizeThatFits(.init(width: min(bounds.width, naturalMode.width), height: nil))
        let filterX = direction == .rightToLeft ? bounds.maxX - filter.width : bounds.minX
        let modeX = direction == .rightToLeft ? bounds.minX : bounds.maxX - mode.width
        let filterY = wraps ? bounds.minY : bounds.maxY - filter.height
        subviews[0].place(at: CGPoint(x: filterX, y: filterY), anchor: .topLeading, proposal: .init(filter))
        subviews[1].place(at: CGPoint(x: modeX, y: bounds.maxY - mode.height),
                          anchor: .topLeading, proposal: .init(mode))
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

/// Calendar's translucent capsule and top-only sheet cannot use the shared
/// opaque rounded-rectangle float without changing their reviewed contours.
/// This decorative Canvas preserves each surface's existing shadow geometry
/// while leaving its native material, clipping, input, and accessibility owner intact.
struct CalendarCanvasOuterShadow<S: InsettableShape>: View {
    let shape: S
    let color: Color
    let geometry: DesignDropShadowGeometry

    var body: some View {
        GeometryReader { proxy in
            let overflow = DesignCanvasGeometry.shadowExtent(geometry)
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                var shadow = context
                shadow.addFilter(.shadow(
                    color: color,
                    radius: geometry.radius,
                    x: geometry.x,
                    y: geometry.y,
                    blendMode: .normal,
                    options: [.shadowOnly]
                ))
                shadow.fill(
                    shape.inset(by: geometry.sourceInset).path(in: faceRect),
                    with: .color(.white)
                )
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
