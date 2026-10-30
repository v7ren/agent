/**
 * Who a message is for. "Answer every message" must not mean "answer messages
 * that are plainly meant for someone else": an @ at another person, with no
 * @ or name for her, is a conversation she is not in.
 */
export function aimedElsewhere(args: {
  meId: string | undefined;
  /** ids of everyone @-mentioned or auto-pinged by a reply */
  mentionedIds: readonly string[];
  /** the text, with mentions already shown as @names */
  text: string;
  /** names that always call her (大肥魚, 肥魚 ...) */
  names: readonly string[];
}): boolean {
  const others = args.mentionedIds.filter((id) => id !== args.meId);
  if (others.length === 0) return false;
  // Her own id in the mentions means she was called too.
  if (args.meId !== undefined && args.mentionedIds.includes(args.meId)) return false;
  return !args.names.some((n) => n !== "" && args.text.includes(n));
}
