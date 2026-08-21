/**
 * Cross-layer Telegram interaction contract. Keep the model schema and the
 * runtime validator on this exact list so a schema-valid reaction cannot be
 * rejected later by Telegram execution.
 */
export const TELEGRAM_REACTION_EMOJI_VALUES = [
  "👍", "👎", "❤", "❤️", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊",
  "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕",
  "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪",
  "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷", "🤷‍♂", "🤷‍♀", "😡",
] as const;
