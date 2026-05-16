type ClipboardLike = {
  writeText: (text: string) => Promise<void>;
};

export type CopyTextOptions = {
  clipboard?: ClipboardLike;
};

export async function copyTextToClipboard(text: string, options: CopyTextOptions = {}): Promise<void> {
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable.");
  }

  await clipboard.writeText(text);
}
