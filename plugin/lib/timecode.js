// Converts Resolve's playhead timecode to the absolute frame numbers that
// TimelineItem.GetStart()/GetEnd() use.
function tcToFrame(tc, fps, dropFrame) {
  const m = /^(\d+):(\d+):(\d+)[:;.,](\d+)$/.exec(String(tc).trim());
  if (!m) return null;
  const [h, min, s, f] = m.slice(1).map(Number);
  const nominal = Math.round(fps);
  let frames = ((h * 60 + min) * 60 + s) * nominal + f;
  if (dropFrame) {
    // 29.97 drops 2 frame numbers each minute except every 10th; 59.94 drops 4.
    const drop = Math.round(nominal / 15);
    const minutes = h * 60 + min;
    frames -= drop * (minutes - Math.floor(minutes / 10));
  }
  return frames;
}

module.exports = { tcToFrame };
