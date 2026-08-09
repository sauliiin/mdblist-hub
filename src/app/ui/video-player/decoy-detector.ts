/** Typical duration window of the playable "file removed" notices. */
const NOTICE_MIN_SECONDS = 30;
const NOTICE_MAX_SECONDS = 2 * 60;
/** A valid source must also be dramatically shorter than the requested title. */
const MAX_EXPECTED_FRACTION = 0.5;

/**
 * Distinguishes a playable error notice from legitimately short content.
 *
 * Duration alone is not enough: a 90-second short film is valid when its
 * metadata also says roughly 90 seconds. A candidate is rejected only when it
 * falls in the known notice window and is less than half the expected runtime.
 * Unknown/invalid metadata always disables the heuristic instead of guessing.
 */
export function isLikelyRemovalNotice(
  actualSeconds: number,
  expectedMinutes: number | null | undefined,
): boolean {
  if (!Number.isFinite(actualSeconds) || actualSeconds <= 0) return false;
  if (!expectedMinutes || !Number.isFinite(expectedMinutes) || expectedMinutes <= 0) return false;

  // Container timestamps commonly turn a nominal 30s/120s clip into 29.97 or
  // 120.04 seconds. Rounding keeps the human duration window inclusive.
  const roundedSeconds = Math.round(actualSeconds);
  const insideNoticeWindow =
    roundedSeconds >= NOTICE_MIN_SECONDS && roundedSeconds <= NOTICE_MAX_SECONDS;

  return insideNoticeWindow && actualSeconds < expectedMinutes * 60 * MAX_EXPECTED_FRACTION;
}
