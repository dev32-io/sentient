import type { JSX } from "preact";
import { MicIcon } from "./icons/mic.tsx";
import { SendIcon } from "./icons/send.tsx";
import { ChatIcon } from "./icons/chat.tsx";
import { BellIcon } from "./icons/bell.tsx";
import { SettingsIcon } from "./icons/settings.tsx";
import { XIcon } from "./icons/x.tsx";
import { SlidersIcon } from "./icons/sliders.tsx";
import { ChevronIcon } from "./icons/chevron.tsx";
import { LampIcon } from "./icons/lamp.tsx";
import { ThermoIcon } from "./icons/thermo.tsx";
import { SparkIcon } from "./icons/spark.tsx";
import { GlobeIcon } from "./icons/globe.tsx";
import { MusicIcon } from "./icons/music.tsx";
import { CheckIcon } from "./icons/check.tsx";
import { PhoneIcon } from "./icons/phone.tsx";
import { PlusIcon } from "./icons/plus.tsx";
import { KeyIcon } from "./icons/key.tsx";
import { PlayIcon } from "./icons/play.tsx";
import { PauseIcon } from "./icons/pause.tsx";
import { TrashIcon } from "./icons/trash.tsx";
import { BookOpenIcon } from "./icons/book-open.tsx";
import { BrainIcon } from "./icons/brain.tsx";
import { DramaIcon } from "./icons/drama.tsx";
import { WaveformIcon } from "./icons/waveform.tsx";
import { CpuIcon } from "./icons/cpu.tsx";
import { WrenchIcon } from "./icons/wrench.tsx";
import { SlidersHIcon } from "./icons/sliders-h.tsx";
import { UserCircleIcon } from "./icons/user-circle.tsx";
import { UsersGroupIcon } from "./icons/users-group.tsx";
import { MenuIcon } from "./icons/menu.tsx";
import { MoreHorizontalIcon } from "./icons/more-horizontal.tsx";
import { PencilIcon } from "./icons/pencil.tsx";
import { SearchIcon } from "./icons/search.tsx";
import { Volume2Icon } from "./icons/volume-2.tsx";
import { VolumeXIcon } from "./icons/volume-x.tsx";
import { CalendarIcon } from "./icons/calendar.tsx";
import { PaperclipIcon } from "./icons/paperclip.tsx";

export type IconName =
  | "mic" | "send" | "chat" | "bell" | "settings"
  | "x" | "sliders" | "chevron" | "lamp" | "thermo" | "spark"
  | "globe" | "music" | "check" | "phone" | "plus"
  | "key" | "play" | "pause" | "trash"
  | "book-open" | "brain" | "drama" | "waveform" | "cpu" | "wrench"
  | "sliders-h" | "user-circle" | "users-group" | "menu"
  | "more-horizontal" | "pencil" | "search"
  | "volume-2" | "volume-x" | "calendar" | "paperclip";

export interface IconProps {
  name: IconName;
  size?: number;
}

const REGISTRY: Record<IconName, (props: { size: number }) => JSX.Element> = {
  mic: MicIcon,
  send: SendIcon,
  chat: ChatIcon,
  bell: BellIcon,
  settings: SettingsIcon,
  x: XIcon,
  sliders: SlidersIcon,
  chevron: ChevronIcon,
  lamp: LampIcon,
  thermo: ThermoIcon,
  spark: SparkIcon,
  globe: GlobeIcon,
  music: MusicIcon,
  check: CheckIcon,
  phone: PhoneIcon,
  plus: PlusIcon,
  key: KeyIcon,
  play: PlayIcon,
  pause: PauseIcon,
  trash: TrashIcon,
  "book-open": BookOpenIcon,
  brain: BrainIcon,
  drama: DramaIcon,
  waveform: WaveformIcon,
  cpu: CpuIcon,
  wrench: WrenchIcon,
  "sliders-h": SlidersHIcon,
  "user-circle": UserCircleIcon,
  "users-group": UsersGroupIcon,
  menu: MenuIcon,
  "more-horizontal": MoreHorizontalIcon,
  pencil: PencilIcon,
  search: SearchIcon,
  "volume-2": Volume2Icon,
  "volume-x": VolumeXIcon,
  calendar: CalendarIcon,
  paperclip: PaperclipIcon,
};

export function Icon({ name, size = 16 }: IconProps): JSX.Element {
  const Component = REGISTRY[name];
  return <Component size={size} />;
}
