type ClipboardLike = {
  writeText: (text: string) => Promise<void>;
};

type TextareaLike = {
  value: string;
  style: Partial<CSSStyleDeclaration>;
  setAttribute: (name: string, value: string) => void;
  focus: (options?: FocusOptions) => void;
  select: () => void;
  setSelectionRange?: (start: number, end: number) => void;
};

type ClipboardDocumentLike = {
  activeElement?: Element | null;
  body?: {
    appendChild: (element: unknown) => unknown;
    removeChild: (element: unknown) => unknown;
  };
  createElement: (tagName: "textarea") => TextareaLike;
  execCommand?: (commandId: string) => boolean;
  addEventListener?: Document["addEventListener"];
  removeEventListener?: Document["removeEventListener"];
  getSelection?: Document["getSelection"];
};

export type CopyTextOptions = {
  clipboard?: ClipboardLike;
  document?: ClipboardDocumentLike;
};

export async function copyTextToClipboard(text: string, options: CopyTextOptions = {}): Promise<boolean> {
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;
  const documentRef = options.document ?? (globalThis.document as unknown as ClipboardDocumentLike | undefined);

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Some browsers expose the Clipboard API but still reject it.
    }
  }

  if (copyTextWithTextarea(text, documentRef)) {
    return true;
  }

  throw new Error("Copy to clipboard failed.");
}

function copyTextWithTextarea(text: string, documentRef: ClipboardDocumentLike | undefined): boolean {
  if (!documentRef?.body || !documentRef.execCommand) {
    return false;
  }

  const textarea = documentRef.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  const selection = documentRef.getSelection?.();
  const selectedRanges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      selectedRanges.push(selection.getRangeAt(index));
    }
  }

  const previousFocus = focusableElement(documentRef.activeElement);
  const copyHandler = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  };

  try {
    documentRef.addEventListener?.("copy", copyHandler);
    documentRef.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange?.(0, text.length);
    return documentRef.execCommand("copy");
  } catch {
    return false;
  } finally {
    documentRef.removeEventListener?.("copy", copyHandler);
    try {
      documentRef.body.removeChild(textarea);
    } catch {
      // If the browser already removed the temporary node, cleanup is complete.
    }
    if (selection) {
      selection.removeAllRanges();
      selectedRanges.forEach((range) => selection.addRange(range));
    }
    previousFocus?.focus({ preventScroll: true });
  }
}

function focusableElement(element: Element | null | undefined): HTMLElement | null {
  if (typeof HTMLElement === "undefined" || !element || !(element instanceof HTMLElement)) {
    return null;
  }

  return element;
}
