export interface CompletionSound {
  unlock(): Promise<void>;
  play(): void;
  dispose(): void;
}

type AudioContextConstructor = new () => AudioContext;

const TONES = [
  { frequency: 880, delay: 0 },
  { frequency: 1_174, delay: 0.08 },
] as const;
const TONE_DURATION_SECONDS = 0.18;
const PEAK_GAIN = 0.06;

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  const globals = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return globalThis.AudioContext ?? globals.webkitAudioContext;
}

function scheduleTone(
  context: AudioContext,
  frequency: number,
  startsAt: number,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const endsAt = startsAt + TONE_DURATION_SECONDS;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startsAt);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startsAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
  oscillator.start(startsAt);
  oscillator.stop(endsAt);
}

export function createCompletionSound(): CompletionSound {
  let context: AudioContext | undefined;
  let disposed = false;

  function ensureContext(): AudioContext | undefined {
    if (disposed || context?.state === "closed") return undefined;
    if (context) return context;
    const Constructor = getAudioContextConstructor();
    if (!Constructor) return undefined;
    try {
      context = new Constructor();
      return context;
    } catch {
      return undefined;
    }
  }

  async function resume(current: AudioContext): Promise<boolean> {
    if (current.state !== "running") {
      try {
        await current.resume();
      } catch {
        return false;
      }
    }
    return !disposed && context === current && current.state === "running";
  }

  async function unlock(): Promise<void> {
    const current = ensureContext();
    if (current) await resume(current);
  }

  function play(): void {
    const current = ensureContext();
    if (!current) return;
    void (async () => {
      if (!await resume(current)) return;
      try {
        for (const tone of TONES) {
          scheduleTone(
            current,
            tone.frequency,
            current.currentTime + tone.delay,
          );
        }
      } catch {
        // Audio failures must not affect the conversation lifecycle.
      }
    })();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const current = context;
    context = undefined;
    if (!current) return;
    try {
      void current.close().catch(() => undefined);
    } catch {
      // Audio cleanup is best effort.
    }
  }

  return { unlock, play, dispose };
}
