/**
 * Cross-extension note row for the Tasks widget.
 *
 * A sibling extension (the multi-signal-sync completion reminder) can pin a
 * one-line notice to the Tasks HUD, so completion-signal reminders surface
 * exactly where the task list lives instead of competing for the footer
 * status bar. The value is read synchronously at every widget render, so a
 * setter call is visible on the next repaint with no extra plumbing.
 */
let attachment: string | undefined;

export function setTaskWidgetAttachment(text: string | undefined): void {
  attachment = text;
}

export function getTaskWidgetAttachment(): string | undefined {
  return attachment;
}
