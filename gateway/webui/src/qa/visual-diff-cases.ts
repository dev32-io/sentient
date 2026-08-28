export interface ActionButtonCase {
  variant: "primary" | "default" | "quiet" | "destructive";
  label: string;
  disabled: boolean;
}

export function actionButtonCase(id: string): ActionButtonCase | undefined {
  const match =
    /^action-button--(primary|secondary|quiet|destructive)--(?:compact-)?(?:rest|hover|focus|pressed|disabled)$/.exec(
      id,
    );
  if (!match) return undefined;
  const role = match[1] as "primary" | "secondary" | "quiet" | "destructive";
  const disabled = id.endsWith("-disabled");
  return {
    variant: role === "secondary" ? "default" : role,
    label: disabled
      ? "Unavailable"
      : role === "primary"
        ? "Allow once"
        : role === "secondary"
          ? "Always allow"
          : role === "quiet"
            ? "Not now"
            : "Stop",
    disabled,
  };
}
