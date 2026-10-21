import arrowClockwise from "@phosphor-icons/core/assets/regular/arrow-clockwise.svg?raw";
import arrowFatLineDown from "@phosphor-icons/core/assets/regular/arrow-fat-line-down.svg?raw";
import arrowUpRight from "@phosphor-icons/core/assets/regular/arrow-up-right.svg?raw";
import arrowUp from "@phosphor-icons/core/assets/regular/arrow-up.svg?raw";
import bookOpenText from "@phosphor-icons/core/assets/regular/book-open-text.svg?raw";
import caretDown from "@phosphor-icons/core/assets/regular/caret-down.svg?raw";
import caretLeft from "@phosphor-icons/core/assets/regular/caret-left.svg?raw";
import caretRight from "@phosphor-icons/core/assets/regular/caret-right.svg?raw";
import chatCircleText from "@phosphor-icons/core/assets/regular/chat-circle-text.svg?raw";
import checkCircle from "@phosphor-icons/core/assets/regular/check-circle.svg?raw";
import check from "@phosphor-icons/core/assets/regular/check.svg?raw";
import circleNotch from "@phosphor-icons/core/assets/regular/circle-notch.svg?raw";
import cloudX from "@phosphor-icons/core/assets/regular/cloud-x.svg?raw";
import copy from "@phosphor-icons/core/assets/regular/copy.svg?raw";
import dotsThree from "@phosphor-icons/core/assets/regular/dots-three.svg?raw";
import fileDashed from "@phosphor-icons/core/assets/regular/file-dashed.svg?raw";
import fileText from "@phosphor-icons/core/assets/regular/file-text.svg?raw";
import files from "@phosphor-icons/core/assets/regular/files.svg?raw";
import gear from "@phosphor-icons/core/assets/regular/gear.svg?raw";
import magnifyingGlass from "@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw";
import minusCircle from "@phosphor-icons/core/assets/regular/minus-circle.svg?raw";
import moon from "@phosphor-icons/core/assets/regular/moon.svg?raw";
import paperclip from "@phosphor-icons/core/assets/regular/paperclip.svg?raw";
import pencilSimple from "@phosphor-icons/core/assets/regular/pencil-simple.svg?raw";
import plus from "@phosphor-icons/core/assets/regular/plus.svg?raw";
import sidebarSimple from "@phosphor-icons/core/assets/regular/sidebar-simple.svg?raw";
import signOut from "@phosphor-icons/core/assets/regular/sign-out.svg?raw";
import stack from "@phosphor-icons/core/assets/regular/stack.svg?raw";
import stop from "@phosphor-icons/core/assets/regular/stop.svg?raw";
import sun from "@phosphor-icons/core/assets/regular/sun.svg?raw";
import trash from "@phosphor-icons/core/assets/regular/trash.svg?raw";
import uploadSimple from "@phosphor-icons/core/assets/regular/upload-simple.svg?raw";
import warningCircle from "@phosphor-icons/core/assets/regular/warning-circle.svg?raw";
import xCircle from "@phosphor-icons/core/assets/regular/x-circle.svg?raw";
import x from "@phosphor-icons/core/assets/regular/x.svg?raw";

export const ICONS = Object.freeze({
  "arrow-clockwise": arrowClockwise,
  "arrow-fat-line-down": arrowFatLineDown,
  "arrow-up": arrowUp,
  "arrow-up-right": arrowUpRight,
  "book-open-text": bookOpenText,
  "caret-down": caretDown,
  "caret-left": caretLeft,
  "caret-right": caretRight,
  "chat-circle-text": chatCircleText,
  check: check,
  "check-circle": checkCircle,
  "circle-notch": circleNotch,
  "cloud-x": cloudX,
  copy: copy,
  "dots-three": dotsThree,
  "file-dashed": fileDashed,
  "file-text": fileText,
  files: files,
  gear: gear,
  "magnifying-glass": magnifyingGlass,
  "minus-circle": minusCircle,
  moon: moon,
  paperclip: paperclip,
  "pencil-simple": pencilSimple,
  plus: plus,
  "sidebar-simple": sidebarSimple,
  "sign-out": signOut,
  stack: stack,
  stop: stop,
  sun: sun,
  trash: trash,
  "upload-simple": uploadSimple,
  "warning-circle": warningCircle,
  x: x,
  "x-circle": xCircle,
}) satisfies Record<string, string>;
export type IconName = keyof typeof ICONS;
