export interface SseParseResult {
  events: string[];
  rest: string;
}

export function splitSseEvents(input: string): SseParseResult {
  const events: string[] = [];
  let start = 0;

  for (;;) {
    const nextLf = input.indexOf("\n\n", start);
    const nextCrLf = input.indexOf("\r\n\r\n", start);

    let next = -1;
    let separatorLength = 0;

    if (nextLf !== -1 && (nextCrLf === -1 || nextLf < nextCrLf)) {
      next = nextLf;
      separatorLength = 2;
    } else if (nextCrLf !== -1) {
      next = nextCrLf;
      separatorLength = 4;
    }

    if (next === -1) break;

    events.push(input.slice(start, next));
    start = next + separatorLength;
  }

  return {
    events,
    rest: input.slice(start)
  };
}

export function getSseData(event: string): string | null {
  const dataLines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}
