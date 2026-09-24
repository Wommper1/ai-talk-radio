/** Job ids become folder names and cancellation keys, so keep one strict form. */
export function isSafeJobId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,119}$/i.test(value) && !value.includes("..");
}

export function shouldWarmUpShow(input: {
  speakLive: boolean;
  hasOpeningAudio: boolean;
  hasOpeningSong: boolean;
}): boolean {
  return input.speakLive && (input.hasOpeningAudio || input.hasOpeningSong);
}
