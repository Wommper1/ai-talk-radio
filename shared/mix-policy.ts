export const MAX_MIX_SECONDS = 30 * 60;
// The target station machine has 32 GB of system RAM. A 30-minute 48 kHz
// stereo float mix remains comfortably inside that budget, so there is no
// reason to silently throw away stereo placement and the music bed at twelve
// minutes. Keep the symbol for policy/test compatibility; degradation begins
// only beyond the duration we reject outright.
export const LOW_MEMORY_MIX_SECONDS = MAX_MIX_SECONDS;

export function mixPolicy(seconds: number, requestedStereo: boolean): {
  allowed: boolean;
  stereo: boolean;
  proceduralBed: boolean;
} {
  const duration = Number.isFinite(seconds) ? Math.max(0, seconds) : Number.POSITIVE_INFINITY;
  const lowMemory = duration > LOW_MEMORY_MIX_SECONDS;
  return {
    allowed: duration <= MAX_MIX_SECONDS,
    stereo: requestedStereo && !lowMemory,
    proceduralBed: !lowMemory,
  };
}
