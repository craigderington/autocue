// Map a word-based reading position to continuous movement between rendered lines.
export function scrollForPosition(rows, position) {
  if (rows.length < 2) return 0;
  let low = 0;
  let high = rows.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (rows[middle].start <= position) low = middle;
    else high = middle - 1;
  }
  const current = rows[low];
  const next = rows[low + 1];
  const fraction = Math.max(0, Math.min(1, (position - current.start) / (next.start - current.start)));
  return current.y + (next.y - current.y) * fraction;
}

export function positionForScroll(rows, scroll) {
  if (rows.length < 2) return 0;
  let index = rows.findIndex((row, i) => i < rows.length - 1 && rows[i + 1].y >= scroll);
  if (index < 0) index = rows.length - 2;
  const current = rows[index];
  const next = rows[index + 1];
  const fraction = Math.max(0, Math.min(1, (scroll - current.y) / (next.y - current.y)));
  return current.start + (next.start - current.start) * fraction;
}

export function advancePosition(position, wordCount, wordsPerMinute, elapsedSeconds) {
  return Math.min(wordCount, position + Math.max(0, elapsedSeconds) * wordsPerMinute / 60);
}
