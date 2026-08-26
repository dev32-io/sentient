import SwiftUI

/// Calendar's native text field primitive. The field keeps the shared input
/// recipe in one place while leaving text state and mutation mapping to the
/// editor sections.
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
        TextField(prompt, text: $text)
            .calendarAutocapitalization(autocapitalization)
            .onChange(of: text) { _, _ in onChange() }
            .calendarInput()
            .calendarAccessibilityIdentifier(accessibilityIdentifier)
    }
}

/// The multiline details field intentionally remains a native SwiftUI
/// TextField so Dynamic Type, selection, and keyboard behavior stay native.
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
        TextField(prompt, text: $text, axis: .vertical)
            .lineLimit(3...7)
            .onChange(of: text) { _, _ in onChange() }
            .calendarInput()
            .calendarAccessibilityIdentifier(accessibilityIdentifier)
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
        TextField("Event title", text: $text)
            .focused(focused)
            .submitLabel(.done)
            .onSubmit { focused.wrappedValue = false }
            .onChange(of: text) { _, _ in onChange() }
            .calendarInput()
            .calendarAccessibilityIdentifier(accessibilityIdentifier)
    }
}

/// Native toggle primitive used by editor sections. It owns only Calendar's
/// semantic tint and forwards the changed value to the section reducer.
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
        Toggle(label, isOn: $isOn)
            .tint(DuskColors.accent)
            .onChange(of: isOn) { _, value in onChange(value) }
            .calendarAccessibilityIdentifier(accessibilityIdentifier)
    }
}

/// Native date control primitive. The optional lower bound is used only by an
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
        nativePicker
            .calendarLabelsHidden(labelsHidden)
            .environment(\.timeZone, timeZone)
            .onChange(of: selection) { _, _ in onChange() }
            .calendarAccessibilityIdentifier(accessibilityIdentifier)
    }

    @ViewBuilder
    private var nativePicker: some View {
        if let minimumDate {
            DatePicker(
                title,
                selection: $selection,
                in: minimumDate...,
                displayedComponents: displayedComponents
            )
        } else {
            DatePicker(title, selection: $selection, displayedComponents: displayedComponents)
        }
    }
}

/// Segmented Picker primitive. Option labels remain supplied by the owning
/// section so this wrapper does not invent domain values.
struct CalendarSegmentedPicker<Selection: Hashable, Options: View>: View {
    let title: String
    @Binding var selection: Selection
    @ViewBuilder let options: () -> Options

    init(
        _ title: String,
        selection: Binding<Selection>,
        @ViewBuilder options: @escaping () -> Options
    ) {
        self.title = title
        _selection = selection
        self.options = options
    }

    var body: some View {
        Picker(title, selection: $selection) {
            options()
        }
        .pickerStyle(.segmented)
    }
}

/// Native stepper primitive for recurrence values.
struct CalendarStepperField: View {
    let label: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    let onChange: () -> Void

    var body: some View {
        Stepper(label, value: $value, in: range)
            .onChange(of: value) { _, _ in onChange() }
    }
}

private extension View {
    func calendarInput() -> some View {
        font(Typo.ui(TypeScale.base))
            .foregroundStyle(DuskColors.ink)
            .padding(.horizontal, Space.md)
            .frame(minHeight: CalendarOverlaySemantics.actionHeight)
            .designWell()
    }

    @ViewBuilder
    func calendarAccessibilityIdentifier(_ identifier: String?) -> some View {
        if let identifier {
            accessibilityIdentifier(identifier)
        } else {
            self
        }
    }

    @ViewBuilder
    func calendarAutocapitalization(_ value: TextInputAutocapitalization?) -> some View {
        if let value {
            textInputAutocapitalization(value)
        } else {
            self
        }
    }

    @ViewBuilder
    func calendarLabelsHidden(_ hidden: Bool) -> some View {
        if hidden {
            labelsHidden()
        } else {
            self
        }
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
