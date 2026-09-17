import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import type { ChatMessage } from "../../types.ts";
import type { MessageVisualState } from "./message-state.ts";

export interface MessageBubbleFrameProps {
  message: ChatMessage;
  name: string;
  identity: ComponentChildren;
  content: ComponentChildren;
  surfaceEffect?: ComponentChildren;
  state?: MessageVisualState | undefined;
  continuation: boolean;
  position?: number | undefined;
  total?: number | undefined;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MessageSurface({ user }: { user: boolean }): JSX.Element {
  const ref = useRef<SVGSVGElement>(null);
  const surfaceId = useId().replaceAll(":", "");

  useEffect(() => {
    const svg = ref.current;
    const body = svg?.parentElement;
    if (!svg || !body) return;
    const identity = body.querySelector<HTMLElement>(".message-bubble__meta");

    const draw = () => {
      const width = body.clientWidth;
      const height = body.clientHeight;
      if (width <= 0 || height <= 0) return;
      const radius = Math.min(18, width / 2, height / 2);
      // Preserve an inner silhouette when fixed foundation erosion exceeds
      // narrow/short geometry; full-size surfaces retain foundation values.
      const adaptiveErosion = Math.max(1, (Math.min(width, height) - 12) / 4);
      svg
        .querySelector(".message-bubble__plate-cast-shape")
        ?.setAttribute("radius", `${Math.min(22, adaptiveErosion)}`);
      svg
        .querySelector(".message-bubble__ember-cast-shape")
        ?.setAttribute("radius", `${Math.min(16, adaptiveErosion)}`);
      const right = width - 1;
      const bottom = height - 1;
      const top = identity ? Math.max(1, identity.offsetHeight - 10) : 1;
      const cap = identity ? Math.min(width, identity.offsetWidth + 6) : width;
      const crown =
        cap > width - 52
          ? `M ${radius} 1 H ${width - radius} Q ${right} 1 ${right} ${radius}`
          : `M ${radius} 1 H ${cap - 12} C ${cap + 12} 1 ${cap + 8} ${top} ${cap + 36} ${top} H ${width - radius} Q ${right} ${top} ${right} ${top + radius}`;
      const path = `${crown} V ${height - radius} Q ${right} ${bottom} ${width - radius} ${bottom} H ${radius} Q 1 ${bottom} 1 ${height - radius} V ${radius} Q 1 1 ${radius} 1 Z`;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      for (const filter of svg.querySelectorAll("filter")) {
        filter.setAttribute("x", "-64");
        filter.setAttribute("y", "-32");
        filter.setAttribute("width", `${width + 128}`);
        filter.setAttribute("height", `${height + 128}`);
      }
      svg
        .querySelector(".message-bubble__surface-shape")
        ?.setAttribute(
          "transform",
          user ? `translate(${width} 0) scale(-1 1)` : "",
        );
      for (const node of svg.querySelectorAll("path"))
        node.setAttribute("d", path);
    };

    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(body);
    if (identity) observer.observe(identity);
    return () => observer.disconnect();
  }, [user]);

  return (
    <svg ref={ref} class="message-bubble__surface" aria-hidden="true">
      <defs>
        <linearGradient id={`${surfaceId}-face`} x2="0" y2="1">
          <stop stop-color="color-mix(in oklab, var(--slate-base) 96%, var(--color-ink))" />
          <stop offset="1" stop-color="var(--slate-base)" />
        </linearGradient>
        <radialGradient id={`${surfaceId}-bow`}>
          <stop stop-color="var(--color-bg-sunk)" stop-opacity=".24" />
          <stop
            offset=".65"
            stop-color="var(--color-bg-sunk)"
            stop-opacity=".12"
          />
          <stop offset="1" stop-color="var(--color-bg-sunk)" stop-opacity="0" />
        </radialGradient>
        <linearGradient id={`${surfaceId}-top-light`} x2="0" y2="1">
          <stop stop-color="var(--color-ink)" stop-opacity=".05" />
          <stop offset=".45" stop-color="var(--color-ink)" stop-opacity="0" />
        </linearGradient>
        <clipPath id={`${surfaceId}-clip`}>
          <path />
        </clipPath>
        {/* Foundation plate-shadow adapted to contour alpha: CSS blur radius maps to half-sized SVG deviation. */}
        <filter
          id={`${surfaceId}-plate`}
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feMorphology
            in="SourceAlpha"
            operator="erode"
            radius="1"
            result="contact-shape"
          />
          <feOffset in="contact-shape" dy="2" result="contact-offset" />
          <feFlood
            flood-color="color-mix(in oklab, var(--color-bg-sunk) 78%, var(--color-line))"
            result="contact-color"
          />
          <feComposite
            in="contact-color"
            in2="contact-offset"
            operator="in"
            result="contact"
          />
          <feMorphology
            class="message-bubble__plate-cast-shape"
            in="SourceAlpha"
            operator="erode"
            radius="22"
            result="cast-shape"
          />
          <feGaussianBlur
            in="cast-shape"
            stdDeviation="15"
            result="cast-blur"
          />
          <feOffset in="cast-blur" dy="18" result="cast-offset" />
          <feFlood flood-color="black" flood-opacity=".9" result="cast-color" />
          <feComposite
            in="cast-color"
            in2="cast-offset"
            operator="in"
            result="cast"
          />
          <feMerge>
            <feMergeNode in="cast" />
            <feMergeNode in="contact" />
          </feMerge>
        </filter>
        {/* Foundation slate-ember-cast, enabled only for active message states. */}
        <filter
          id={`${surfaceId}-ember`}
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feMorphology
            class="message-bubble__ember-cast-shape"
            in="SourceAlpha"
            operator="erode"
            radius="16"
            result="ember-shape"
          />
          <feGaussianBlur
            in="ember-shape"
            stdDeviation="10"
            result="ember-blur"
          />
          <feOffset in="ember-blur" dy="12" result="ember-offset" />
          <feFlood
            flood-color="var(--color-accent)"
            flood-opacity=".42"
            result="ember-color"
          />
          <feComposite in="ember-color" in2="ember-offset" operator="in" />
        </filter>
      </defs>
      <g class="message-bubble__surface-shape">
        <path
          class="message-bubble__surface-shadow"
          filter={`url(#${surfaceId}-plate)`}
        />
        <path
          class="message-bubble__surface-ember"
          filter={`url(#${surfaceId}-ember)`}
        />
        <path fill={`url(#${surfaceId}-face)`} />
        <path fill={`url(#${surfaceId}-bow)`} />
        <g clip-path={`url(#${surfaceId}-clip)`}>
          <path
            fill="none"
            stroke={`url(#${surfaceId}-top-light)`}
            stroke-width="2"
          />
        </g>
        <path fill="none" stroke="var(--slate-border)" stroke-width="1" />
      </g>
    </svg>
  );
}

export function MessageBubbleFrame({
  message,
  name,
  identity,
  content,
  surfaceEffect,
  state,
  continuation,
  position,
  total,
}: MessageBubbleFrameProps): JSX.Element {
  const chronology =
    position !== undefined && total !== undefined
      ? `Message ${position} of ${total}`
      : "Message";
  const cutoffLabel = message.cutoff ? ", interrupted" : "";
  const messageKey = message.pendingId ?? message.id;

  return (
    <article
      class={`message-bubble message-bubble--${message.role}${continuation ? " message-bubble--continuation" : ""}`}
      aria-label={`${chronology} from ${name} at ${formatTime(message.timestamp)}${cutoffLabel}`}
      data-message-key={messageKey}
      data-pending-id={message.pendingId}
      data-message-role={message.role}
      data-message-state={state}
    >
      <div class="message-bubble__body">
        <MessageSurface user={message.role === "user"} />
        {!continuation && (
          <header class="message-bubble__meta">
            {identity}
            <span class="message-bubble__name">{name}</span>
            <span class="message-bubble__sep" aria-hidden="true">
              ·
            </span>
            <time dateTime={new Date(message.timestamp).toISOString()}>
              {formatTime(message.timestamp)}
            </time>
          </header>
        )}
        <div class="message-bubble__text-wrap">
          {surfaceEffect && (
            <span class="message-bubble__activity" aria-hidden="true">
              {surfaceEffect}
            </span>
          )}
          <div class="message-bubble__text-inner">{content}</div>
        </div>
      </div>
    </article>
  );
}
