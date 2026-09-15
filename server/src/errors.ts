/** A failure the interface will put in front of someone. The key lets the client render
 *  it in the language that person chose; the English text is the fallback for any client
 *  that does not know the key -- an older build, or a message added after it shipped.
 *  Variables fill the placeholders a catalogue entry leaves in that text, and are only
 *  worth carrying where the question cannot be phrased without them.
 *  Failures that only ever reach the log carry no key and stay plain English. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly messageKey: string,
    readonly status?: number,
    readonly vars?: Record<string, string | number>,
  ) { super(message); }
}

export const messageKeyOf = (error: unknown): string | undefined =>
  typeof (error as { messageKey?: unknown })?.messageKey === "string" ? (error as { messageKey: string }).messageKey : undefined;
