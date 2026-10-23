// After a conversion restart the video starts at zero, so the subtitles have to shift by the same amount.
const CUE = /(\d{2,}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3}) --> (\d{2,}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/;
const cueSeconds = (value: string) => { const parts = value.split(":").map(Number); return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]; };
const cueStamp = (value: number) => { const total = Math.max(0, value); return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${(total % 60).toFixed(3).padStart(6, "0")}`; };

export function shiftVtt(text: string, offset: number) {
  // Blocks are found by their blank lines, which a file saved on Windows spells "\r\n\r\n".
  return text.replace(/\r\n?/g, "\n").split(/\n\n+/).map((block) => {
    const match = block.match(CUE); if (!match) return block;
    const end = cueSeconds(match[2]) - offset; if (end <= 0) return "";
    return block.replace(CUE, `${cueStamp(cueSeconds(match[1]) - offset)} --> ${cueStamp(end)}`);
  }).filter(Boolean).join("\n\n");
}

/** A sidecar is read while FFmpeg is still writing it, so the last block can be half a cue. */
export function completeVttBlocks(text: string) {
  const blocks = text.split(/\n\n+/);
  const last = blocks.at(-1);
  if (last !== undefined && last.trim() && !text.endsWith("\n\n")) blocks.pop();
  return blocks.join("\n\n");
}

/** How far into the film the cues written so far reach. */
export function vttCoverage(text: string) {
  let furthest = -Infinity;
  for (const block of text.split(/\n\n+/)) {
    const match = block.match(CUE);
    if (match) furthest = Math.max(furthest, cueSeconds(match[2]));
  }
  return furthest;
}
