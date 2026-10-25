// page-dom.ts — the page, as far as the probe's page-side functions use it: the types of the DOM that
// probe-page.ts, probe-drive.ts, probe-behaviour.ts and probe-visual.ts read inside page.evaluate.
//
// Types only, imported with `import type`: the design-to-code tsconfig has no DOM lib (the rest of this layer runs in Node,
// where `document` does not exist), and a page-side function is serialised with Function.prototype.toString() and run as
// TEXT in the page, so it must reference nothing outside its own body. Types erase, so nothing here reaches a bundle; each
// module still declares the page globals it uses (`declare const document: PageDocument`, …) itself — a declaration is
// module-local and erased too.
//
// One set for the four modules: each member is here because one of them reads it (the union of what they use), typed as
// the browser has it.

/** a box in viewport coordinates — a DOMRect's edges, or one the probe computes itself (a generated label's box) */
export interface PageBox { x: number; y: number; width: number; height: number; right: number; bottom: number }
/** what getBoundingClientRect / getClientRects return (a DOMRect) */
export interface PageRect extends PageBox { left: number; top: number }
export interface PageStyle { getPropertyValue(prop: string): string }
/** an element's inline style (el.style) */
export interface PageInlineStyle {
  setProperty(prop: string, value: string, priority?: string): void;
  removeProperty(prop: string): string;
  getPropertyValue(prop: string): string;
  getPropertyPriority(prop: string): string;
}
/** a NodeList / HTMLCollection */
export interface PageList<T> extends ArrayLike<T> { item(i: number): T | null }
/** a node (nodeType 3 = text) */
export interface PageNode {
  nodeType: number;
  nodeValue: string | null;
  textContent: string | null;
  childNodes: ArrayLike<PageNode>;
  /** the slot a slotted node is shown in (the flat tree a click's event path follows) */
  assignedSlot?: PageElement | null;
}
/** a constructed style sheet (a page's CSP style-src blocks an injected <style>, never CSSOM) */
export interface PageSheet { replaceSync(text: string): void }
/** an open shadow root */
export interface PageShadowRoot {
  activeElement: PageElement | null;
  children: ArrayLike<PageElement>;
  childNodes: ArrayLike<PageNode>;
  elementFromPoint?(x: number, y: number): PageElement | null;
  /** the probe's hiding sheet is adopted into each open shadow root inside the container */
  adoptedStyleSheets: PageSheet[];
}
export interface PageCheckVisibility { visibilityProperty?: boolean; checkVisibilityCSS?: boolean; opacityProperty?: boolean; checkOpacity?: boolean; contentVisibilityAuto?: boolean }
export interface PageScrollIntoView { block?: string; inline?: string; behavior?: string }
export interface PageElement extends PageNode {
  tagName: string;
  id: string;
  isConnected: boolean;
  children: ArrayLike<PageElement>;
  parentElement: PageElement | null;
  /** an input's placeholder */
  placeholder?: string;
  /** an <input>/<textarea>/<select>'s current value (HTMLInputElement.value — not its child text) */
  value?: string;
  /** an <input>'s type (lower case; "text" when absent or unknown) */
  type?: string;
  /** a <select>'s multiple / size: either makes it a list box showing every option */
  multiple?: boolean;
  size?: number;
  /** a <select>'s selected <option>s */
  selectedOptions?: ArrayLike<PageElement>;
  /** an <option>'s text (HTMLOptionElement.text: its text, whitespace collapsed) */
  text?: string;
  /** an <option>'s label (HTMLOptionElement.label: its label attribute, else its text) — what a collapsed <select> shows */
  label?: string;
  /** a <label>'s control (HTMLLabelElement.control) */
  control?: PageElement | null;
  form?: unknown;
  isContentEditable?: boolean;
  /** the left / top border widths (the padding box's offset inside the border box) */
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  /** an ancestor's scroll moves the own-content check's start edge */
  scrollLeft: number;
  scrollTop: number;
  style: PageInlineStyle;
  shadowRoot?: PageShadowRoot | null;
  getRootNode?(): { host?: PageElement; children?: ArrayLike<PageElement> } | null;
  getAnimations?(opts?: { subtree?: boolean }): Array<{ playState: string; finished: Promise<unknown> }>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): PageRect;
  getClientRects(): ArrayLike<PageRect>;
  closest(selector: string): PageElement | null;
  matches(selector: string): boolean;
  contains(other: PageElement): boolean;
  checkVisibility(opts?: PageCheckVisibility): boolean;
  querySelectorAll(selector: string): PageList<PageElement>;
  click(): void;
  focus(opts?: { preventScroll?: boolean }): void;
  blur(): void;
  scrollTo(opts: { left: number; top: number; behavior: "instant" }): void;
  scrollIntoView(opts?: PageScrollIntoView): void;
  prepend(node: PageElement): void;
  remove(): void;
}
export interface PageRange { selectNodeContents(node: PageNode): void; getBoundingClientRect(): PageRect; getClientRects(): ArrayLike<PageRect> }
export interface PageCanvasContext {
  fillStyle: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
}
export interface PageCanvas { width: number; height: number; getContext(kind: "2d", opts?: { willReadFrequently?: boolean }): PageCanvasContext | null }
export interface PageDocument {
  body: PageElement | null;
  documentElement: PageElement;
  activeElement: PageElement | null;
  /** the probe's own constructed sheet */
  adoptedStyleSheets: PageSheet[];
  compatMode: string;
  fonts: { ready: Promise<unknown> };
  elementFromPoint(x: number, y: number): PageElement | null;
  /** the hit stack at a point */
  elementsFromPoint(x: number, y: number): PageElement[];
  querySelector(selector: string): PageElement | null;
  querySelectorAll(selector: string): PageList<PageElement>;
  getElementById(id: string): PageElement | null;
  createElement(tag: "canvas"): PageCanvas;
  createElement(tag: string): PageElement;
  createRange(): PageRange;
}

// ---------------------------------------------------------------- what the page-side functions keep on window between calls
/** the drive's snapshot before its click (armDetector → pollDetector) */
export interface DriveState { before: PageElement[]; destBefore: PageElement[]; destPaths: string[]; roots?: PageElement[] }
/** the scroll the drive had before its click (saveScroll / restoreScroll) */
export interface DriveScroll { x: number; y: number; boxes: Array<{ el: PageElement; left: number; top: number }> }
/** the container and the control the pixel check compares (set by clickPointControl's and markOpener's own-control path), and
 *  the scroll ownMark had before it brought the container into view */
export interface OwnPair {
  box: PageElement; ctl: PageElement; saved?: DriveScroll; focus?: PageElement; sheet?: PageSheet;
  /** the open shadow roots inside the container (inCtl: the control's own), and the sheet adopted into them */
  roots?: Array<{ root: PageShadowRoot; inCtl: boolean }>; rootSheet?: PageSheet;
  /** every element of the container's flat tree (open shadow roots included) and whether it is the control's */
  els?: Array<{ e: PageElement; inCtl: boolean }>;
}
/** What the behaviour checks keep between calls (window.__dtBeh): element references, never paths (a path shifts when
 *  the sentinel is inserted or the app re-renders). */
export interface BehState {
  /** the modal root (for "inside": focus, tabbables, controls) and the element whose box IS the dialog on screen (a
   *  Headless UI root has a 0-px box — its panel is the box) */
  box?: PageElement | null;
  stops: PageElement[];
  stopVisible: boolean[];
  sentinel: PageElement | null;
  opener: PageElement | null;
  /** the opener's own control (markOpener) — the one element a key is pressed on, focused, or counted as reaching it */
  control?: PageElement | null;
  /** the container / sole-control pairs this page's pixel check already judged (own = the container shows content of its
   *  own: the control is not the opener's) — each pair is shot once per unit page */
  ownSeen?: Array<{ box: PageElement; ctl: PageElement; own: boolean; why?: string | null }>;
  dialog: PageElement | null;
  dialogModal: boolean;
  expander: PageElement | null;
  masks: PageElement[];
  maskInline: Array<{ value: string; priority: string }>;
}
export interface PageWindow {
  __dtDrive?: DriveState;
  __dtDriveScroll?: DriveScroll;
  __dtOwn?: OwnPair | null;
  __dtOwnWhy?: string | null;
  /** tipPreMark's set (probe-drive.ts): the [role=tooltip] elements and the elements with an id already shown before the
   *  probe acted on the page */
  __dtTipPre?: WeakSet<PageElement> | null;
  __dtBeh?: BehState;
  /** the measurement pass's document token (an init script sets it per document) */
  __dtProbeDoc?: string;
  scrollTo(opts: { top: number; left: number; behavior: string }): void;
}
