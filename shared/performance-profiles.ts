export type PerformanceProfile = "fast" | "balanced" | "produced" | "custom";

export interface PerformanceSettings {
  show: {
    performanceProfile: PerformanceProfile;
    useProducer: boolean;
    useOutline: boolean;
    generateNotes: boolean;
    warmUpModel: boolean;
  };
  memory: { enabled: boolean; updateEvery: number };
  imaging: { useIdent: boolean; useTransitions: boolean; useCallStings: boolean };
}

export function applyPerformanceProfile<T extends PerformanceSettings>(config: T, profile: Exclude<PerformanceProfile, "custom">): T {
  const values = profile === "fast"
    ? { useProducer: false, useOutline: false, generateNotes: false, warmUpModel: false, memory: false, updateEvery: 8, imaging: false }
    : profile === "balanced"
      ? { useProducer: false, useOutline: false, generateNotes: true, warmUpModel: true, memory: true, updateEvery: 6, imaging: true }
      : { useProducer: true, useOutline: true, generateNotes: true, warmUpModel: true, memory: true, updateEvery: 4, imaging: true };

  return {
    ...config,
    show: { ...config.show, performanceProfile: profile, useProducer: values.useProducer, useOutline: values.useOutline, generateNotes: values.generateNotes, warmUpModel: values.warmUpModel },
    memory: { ...config.memory, enabled: values.memory, updateEvery: values.updateEvery },
    imaging: { ...config.imaging, useIdent: values.imaging, useTransitions: values.imaging, useCallStings: values.imaging },
  };
}

/** Return the named preset only when every setting it owns still matches. */
export function matchingPerformanceProfile(config: PerformanceSettings): PerformanceProfile {
  for (const profile of ["fast", "balanced", "produced"] as const) {
    const expected = applyPerformanceProfile(config, profile);
    if (
      config.show.useProducer === expected.show.useProducer &&
      config.show.useOutline === expected.show.useOutline &&
      config.show.generateNotes === expected.show.generateNotes &&
      config.show.warmUpModel === expected.show.warmUpModel &&
      config.memory.enabled === expected.memory.enabled &&
      config.memory.updateEvery === expected.memory.updateEvery &&
      config.imaging.useIdent === expected.imaging.useIdent &&
      config.imaging.useTransitions === expected.imaging.useTransitions &&
      config.imaging.useCallStings === expected.imaging.useCallStings
    ) return profile;
  }
  return "custom";
}
