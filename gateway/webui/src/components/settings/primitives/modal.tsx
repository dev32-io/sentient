import type { ComponentChildren, JSX } from "preact";
import { Dialog } from "../../common/dialog.tsx";
export interface ModalProps { title: string; children: ComponentChildren; footer?: JSX.Element; onClose: () => void; width?: number; }
export function Modal({ title, children, footer, onClose, width = 440 }: ModalProps): JSX.Element {
  return <Dialog title={title} {...(footer ? { footer } : {})} onClose={onClose} width={width} inertBackground>{children}</Dialog>;
}
