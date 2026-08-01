interface CompletionAudioContext extends AudioContext {
  state: AudioContextState;
}

export interface CompletionSound {
  unlock(): Promise<void>;
  play(): void;
  dispose(): void;
}

const FIRST_FREQUENCY = 880;
const SECOND_FREQUENCY = 1_174;
const TONE_DURATION_SECONDS = 0.18;
const SECOND_TONE_DELAY_SECONDS = 0.08;
const PEAK_GAIN = 0.06;

function audioContextConstructor(): (new () => CompletionAudioContext) | undefined {
  const globals = globalThis as typeof globalThis & {
    webkitAudioContext?: new () => CompletionAudioContext;
  };
  return globalThis.AudioContext ?? globals.webkitAudioContext;
}

export function createCompletionSound(): CompletionSound {
  let context: CompletionAudioContext | undefined;
  let disposed = false;
  const oscillators = new Set<OscillatorNode>();
  const nodes = new Set<AudioNode>();

  const ensureContext = (): CompletionAudioContext | undefined => {
    if (disposed || context?.state === "closed") return undefined;
    if (context) return context;
    const Constructor = audioContextConstructor();
    if (!Constructor) return undefined;
    try {
      context = new Constructor();
      return context;
    } catch {
      return undefined;
    }
  };

  const forgetNodes = (oscillator: OscillatorNode, gain: GainNode) => {
    oscillators.delete(oscillator);
    nodes.delete(oscillator);
    nodes.delete(gain);
    try {
      oscillator.disconnect();
    } catch {
      // A browser may already have disconnected the ended oscillator.
    }
    try {
      gain.disconnect();
    } catch {
      // A browser may already have disconnected the ended gain node.
    }
  };

  const unlock = async (): Promise<void> => {
    const current = ensureContext();
    if (!current || current.state === "closed" || current.state === "running") return;
    try {
      await current.resume();
    } catch {
      // Autoplay policy can reject resume; a later user gesture can retry.
    }
  };

  const scheduleChime = (current: CompletionAudioContext): void => {
    const start = current.currentTime;
    const tones = [
      { frequency: FIRST_FREQUENCY, offset: 0 },
      { frequency: SECOND_FREQUENCY, offset: SECOND_TONE_DELAY_SECONDS },
    ];
    const created: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];
    try {
      for (const tone of tones) {
        const oscillator = current.createOscillator();
        const gain = current.createGain();
        created.push({ oscillator, gain });
        const toneStart = start + tone.offset;
        const toneEnd = toneStart + TONE_DURATION_SECONDS;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
        gain.gain.setValueAtTime(0.0001, toneStart);
        gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, toneStart + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
        oscillator.connect(gain);
        gain.connect(current.destination);
        oscillator.onended = () => forgetNodes(oscillator, gain);
        oscillator.start(toneStart);
        oscillator.stop(toneEnd);
        oscillators.add(oscillator);
        nodes.add(oscillator);
        nodes.add(gain);
      }
    } catch {
      for (const { oscillator, gain } of created) {
        forgetNodes(oscillator, gain);
      }
    }
  };

  const play = (): void => {
    const current = ensureContext();
    if (!current || current.state === "closed") return;
    void (async () => {
      if (current.state !== "running") await unlock();
      if (
        disposed
        || context !== current
        || current.state !== "running"
      ) return;
      scheduleChime(current);
    })();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const oscillator of oscillators) {
      try {
        oscillator.stop();
      } catch {
        // The oscillator may have already ended.
      }
      try {
        oscillator.disconnect();
      } catch {
        // Cleanup is best effort.
      }
    }
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // Cleanup is best effort.
      }
    }
    oscillators.clear();
    nodes.clear();
    const current = context;
    context = undefined;
    if (current) {
      try {
        void current.close().catch(() => undefined);
      } catch {
        // Audio cleanup must never affect the application.
      }
    }
  };

  return { unlock, play, dispose };
}
