/** Typical duration window of the playable "file removed" notices. */
const NOTICE_MIN_SECONDS = 30;
// The live provider currently returns a nominal two-minute notice as 120.96s.
// Three minutes leaves container timestamp drift without approaching a real
// feature; the expected-runtime fraction below still protects genuine shorts.
const NOTICE_MAX_SECONDS = 3 * 60;
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

  // Container timestamps commonly move the nominal 30s/120s boundaries.
  const roundedSeconds = Math.round(actualSeconds);
  const insideNoticeWindow =
    roundedSeconds >= NOTICE_MIN_SECONDS && roundedSeconds <= NOTICE_MAX_SECONDS;

  return insideNoticeWindow && actualSeconds < expectedMinutes * 60 * MAX_EXPECTED_FRACTION;
}
