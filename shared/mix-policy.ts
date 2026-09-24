export const LOW_MEMORY_MIX_SECONDS = 12 * 60;
export const MAX_MIX_SECONDS = 30 * 60;

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
