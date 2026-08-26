import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { ActionButton, FoundationIconButton } from "../common/index.ts";
import type { ProjectedCalendarOccurrence } from "./calendar-projection-types.ts";
import type { EventPreviewModel } from "./event-preview-details.ts";

export interface EventPreviewContentProps {
  readonly model: EventPreviewModel;
  readonly titleId: string;
  readonly descriptionId: string;
  readonly onClose: () => void;
  readonly onAction: (callback: ((occurrence: ProjectedCalendarOccurrence) => void) | undefined) => void;
  readonly onEdit?: (occurrence: ProjectedCalendarOccurrence) => void;
  readonly onDelete?: (occurrence: ProjectedCalendarOccurrence) => void;
}

/** Pure preview body; focus, positioning, and dismissal stay in EventPreview. */
export function EventPreviewContent({ model, titleId, descriptionId, onClose, onAction, onEdit, onDelete }: EventPreviewContentProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    closeRef.current?.setAttribute("data-od-id", "calendar-event-preview-close");
    closeRef.current?.setAttribute("data-event-preview-initial-focus", "true");
  }, []);
  const when = model.details.find((item) => item.key === "when")?.value ?? "";
  const detailRows = model.details.filter((item) => item.key !== "when");
  return (
    <div class="event-preview__body" data-scrollable="true">
      <FoundationIconButton
        label="Close event details"
        buttonRef={closeRef}
        className="event-preview__close"
        hasPopup="dialog"
        onClick={() => onClose()}
      >
        <span aria-hidden="true" />
      </FoundationIconButton>
      <p class="event-preview__kicker">Event preview</p>
      <h2 class="event-preview__title" id={titleId}>{model.occurrence.title || "Event details"}</h2>
      <p class="event-preview__time" aria-label={`When: ${when}`}><span class="event-preview__sr-only">When: </span>{when}</p>
      {model.description && <p class="event-preview__description" id={descriptionId}>{model.description}</p>}
      <dl class="event-preview__meta">
        {detailRows.map((item) => (
          <div class="event-preview__detail" data-detail-key={item.key} key={item.key}>
            <dt>{item.label}</dt>
            <dd>
              {item.key === "tags" ? (
                <span class="event-preview__tags">
                  {model.occurrence.tags.map((tag) => <span class="event-preview__tag" key={tag}>{tag}</span>)}
                </span>
              ) : item.value}
            </dd>
          </div>
        ))}
      </dl>
      <div class="event-preview__actions">
        <ActionButton
          className="event-preview__action event-preview__action--edit"
          disabled={!onEdit}
          onClick={() => onAction(onEdit)}
        >
          Edit
        </ActionButton>
        <ActionButton
          className="event-preview__action event-preview__action--delete"
          disabled={!onDelete}
          onClick={() => onAction(onDelete)}
        >
          Delete
        </ActionButton>
      </div>
    </div>
  );
}
