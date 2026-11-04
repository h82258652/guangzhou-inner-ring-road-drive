/** Persisted user settings and quality presets. */
export type Quality = 'low' | 'medium' | 'high';
export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
export type WeatherSetting = 'clear' | 'cloudy' | 'rain';
export type Mode = 'free' | 'trip' | 'lap';
export type CarChoice = 'sedan' | 'taxi' | 'suv';

export interface GameOptions {
  line: 'A' | 'B';
  mode: Mode;
  start: string;
  destination: string;
  time: TimeOfDay;
  weather: WeatherSetting;
  traffic: 'sparse' | 'normal' | 'rush';
  car: CarChoice;
}

export interface Settings {
  quality: Quality;
  volume: number;
  steerSensitivity: number;
  showFps: boolean;
  options: GameOptions;
}

export const QUALITY: Record<Quality, { pixelRatio: number; shadows: boolean; shadowSize: number; drawDistance: number; trees: boolean; infill: boolean; bloom: boolean; antialias: boolean }> = {
  low: { pixelRatio: 0.75, shadows: false, shadowSize: 1024, drawDistance: 1500, trees: false, infill: false, bloom: false, antialias: false },
  medium: { pixelRatio: 1, shadows: true, shadowSize: 1024, drawDistance: 2300, trees: true, infill: true, bloom: false, antialias: true },
  high: { pixelRatio: 1.5, shadows: true, shadowSize: 2048, drawDistance: 3400, trees: true, infill: true, bloom: true, antialias: true },
};

export const TIME_HOURS: Record<TimeOfDay, number> = { dawn: 6.6, day: 13.5, dusk: 18.35, night: 21.5 };

const KEY = 'gz-inner-ring-settings-v1';

export function defaultSettings(): Settings {
  return {
    quality: 'medium',
    volume: 0.7,
    steerSensitivity: 1,
    showFps: true,
    options: { line: 'A', mode: 'free', start: 'main:0', destination: '', time: 'day', weather: 'clear', traffic: 'normal', car: 'sedan' },
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      const d = defaultSettings();
      return { ...d, ...s, options: { ...d.options, ...(s.options ?? {}) } };
    }
  } catch {
    /* ignore */
  }
  return defaultSettings();
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
