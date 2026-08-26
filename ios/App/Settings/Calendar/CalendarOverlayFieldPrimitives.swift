import SwiftUI

/// Calendar's text field adapter keeps Calendar's prompt, mutation callback,
/// and accessibility identity while delegating input rendering and semantics
/// to the shared Design field.
struct CalendarTextField: View {
    let prompt: String
    @Binding var text: String
    let autocapitalization: TextInputAutocapitalization?
    let accessibilityIdentifier: String?
    let onChange: () -> Void

    init(
        prompt: String,
        text: Binding<String>,
        autocapitalization: TextInputAutocapitalization? = nil,
        accessibilityIdentifier: String? = nil,
        onChange: @escaping () -> Void
    ) {
        self.prompt = prompt
        _text = text
        self.autocapitalization = autocapitalization
        self.accessibilityIdentifier = accessibilityIdentifier
        self.onChange = onChange
    }

    var body: some View {
        DesignField(
            title: prompt,
            prompt: prompt,
            text: $text,
            accessibilityId: accessibilityIdentifier,
            showsTitle: false,
            accessibilityLabel: prompt,
            autocapitalization: autocapitalization,
            minimumHeight: CalendarOverlaySemantics.actionHeight,
            onChange: { _ in onChange() }
        )
    }
}

/// The multiline details field remains a native SwiftUI axis-aware TextField;
/// the shared Design field supplies its surface and accessibility contract.
struct CalendarMultilineTextField: View {
    let prompt: String
    @Binding var text: String
    let accessibilityIdentifier: String?
    let onChange: () -> Void

    init(
        prompt: String,
        text: Binding<String>,
        accessibilityIdentifier: String? = nil,
        onChange: @escaping () -> Void
    ) {
        self.prompt = prompt
        _text = text
        self.accessibilityIdentifier = accessibilityIdentifier
        self.onChange = onChange
    }

    var body: some View {
        DesignField(
            title: prompt,
            prompt: prompt,
            text: $text,
            accessibilityId: accessibilityIdentifier,
            showsTitle: false,
            accessibilityLabel: prompt,
            axis: .vertical,
            lineLimit: 3...7,
            minimumHeight: CalendarOverlaySemantics.actionHeight,
            onChange: { _ in onChange() }
        )
    }
}

/// Title is the only editor field with an explicit focus and keyboard-submit
/// contract.
struct CalendarTitleField: View {
    @Binding var text: String
    let focused: FocusState<Bool>.Binding
    let accessibilityIdentifier: String?
    let onChange: () -> Void

    init(
        text: Binding<String>,
        focused: FocusState<Bool>.Binding,
        accessibilityIdentifier: String? = nil,
        onChange: @escaping () -> Void
    ) {
        _text = text
        self.focused = focused
        self.accessibilityIdentifier = accessibilityIdentifier
        self.onChange = onChange
    }

    var body: some View {
        DesignField(
            title: "Event title",
            prompt: "Event title",
            text: $text,
            accessibilityId: accessibilityIdentifier,
            showsTitle: false,
            accessibilityLabel: "Event title",
            minimumHeight: CalendarOverlaySemantics.actionHeight,
            focused: focused,
            submitLabel: .done,
            onSubmit: { focused.wrappedValue = false },
            onChange: { _ in onChange() }
        )
    }
}

/// Native toggle adapter used by editor sections. It owns only Calendar's
/// labels and mutation callback while Design owns the toggle semantics.
struct CalendarToggleField: View {
    let label: String
    @Binding var isOn: Bool
    let accessibilityIdentifier: String?
    let onChange: (Bool) -> Void

    init(
        label: String,
        isOn: Binding<Bool>,
        accessibilityIdentifier: String? = nil,
        onChange: @escaping (Bool) -> Void
    ) {
        self.label = label
        _isOn = isOn
        self.accessibilityIdentifier = accessibilityIdentifier
        self.onChange = onChange
    }

    var body: some View {
        DesignToggleRow(
            title: label,
            isOn: $isOn,
            accessibilityId: accessibilityIdentifier
        )
        .onChange(of: isOn) { _, value in onChange(value) }
    }
}

/// Native date control adapter. The optional lower bound is used only by an
/// end date; all other date controls retain DatePicker's normal range.
struct CalendarDateField: View {
    let title: String
    @Binding var selection: Date
    let minimumDate: Date?
    let displayedComponents: DatePickerComponents
    let timeZone: TimeZone
    let labelsHidden: Bool
    let accessibilityIdentifier: String?
    let onChange: () -> Void

    init(
        title: String,
        selection: Binding<Date>,
        minimumDate: Date? = nil,
        displayedComponents: DatePickerComponents,
        timeZone: TimeZone,
        labelsHidden: Bool = true,
        accessibilityIdentifier: String? = nil,
        onChange: @escaping () -> Void
    ) {
        self.title = title
        _selection = selection
        self.minimumDate = minimumDate
        self.displayedComponents = displayedComponents
        self.timeZone = timeZone
        self.labelsHidden = labelsHidden
        self.accessibilityIdentifier = accessibilityIdentifier
        self.onChange = onChange
    }

    var body: some View {
        DesignDatePicker(
            title: title,
            selection: $selection,
            range: minimumDate.map { $0... },
            displayedComponents: displayedComponents,
            timeZone: timeZone,
            labelsHidden: labelsHidden,
            accessibilityId: accessibilityIdentifier,
            minimumHeight: CalendarOverlaySemantics.actionHeight
        )
        .onChange(of: selection) { _, _ in onChange() }
    }
}

/// Segmented picker adapter. Option labels and values remain supplied by the
/// owning section while the native picker and accessibility contract live in
/// the Design foundation.
struct CalendarSegmentedPicker<Selection: Hashable>: View {
    let title: String
    let options: [(value: Selection, label: String)]
    @Binding var selection: Selection

    init(
        _ title: String,
        selection: Binding<Selection>,
        options: [(value: Selection, label: String)]
    ) {
        self.title = title
        self.options = options
        _selection = selection
    }

    var body: some View {
        DesignSegmentedPicker(
            title: title,
            options: options,
            selection: $selection
        )
    }
}

/// Stepper adapter for recurrence values. Calendar retains its labels and
/// reducer callback while the native control is owned by Design.
struct CalendarStepperField: View {
    let label: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    let onChange: () -> Void

    var body: some View {
        DesignStepper(title: label, value: $value, range: range)
            .onChange(of: value) { _, _ in onChange() }
    }
}

struct CalendarLabeledField<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink3)
            content()
        }
    }
}
