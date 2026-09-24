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
