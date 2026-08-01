import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompletionSound } from "./completion-sound";

class FakeAudioParam {
  readonly setValueAtTime = vi.fn();
  readonly exponentialRampToValueAtTime = vi.fn();
}

class FakeNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeOscillator extends FakeNode {
  type = "sine";
  frequency = new FakeAudioParam();
  onended?: () => void;
  readonly start = vi.fn();
  readonly stop = vi.fn(() => this.onended?.());
}

class FakeGain extends FakeNode {
  gain = new FakeAudioParam();
}

class FakeAudioContext {
  state: AudioContextState = "suspended";
  currentTime = 10;
  readonly destination = new FakeNode();
  readonly oscillators: FakeOscillator[] = [];
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    return new FakeGain();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCompletionSound", () => {
  it("is a silent no-op when Web Audio is unavailable", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const sound = createCompletionSound();

    await expect(sound.unlock()).resolves.toBeUndefined();
    expect(() => sound.play()).not.toThrow();
    expect(() => sound.dispose()).not.toThrow();
  });

  it("schedules a two-tone chime after unlock and cleans it up", async () => {
    const context = new FakeAudioContext();
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return context;
      }
    });
    const sound = createCompletionSound();

    await sound.unlock();
    sound.play();

    await vi.waitFor(() => expect(context.oscillators).toHaveLength(2));
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.oscillators[0]!.frequency.setValueAtTime)
      .toHaveBeenCalledWith(880, 10);
    expect(context.oscillators[1]!.frequency.setValueAtTime)
      .toHaveBeenCalledWith(1_174, 10.08);
    expect(context.oscillators[0]!.start).toHaveBeenCalledWith(10);
    expect(context.oscillators[1]!.start).toHaveBeenCalledWith(10.08);
    expect(context.oscillators[0]!.stop).toHaveBeenCalledWith(10.18);
    expect(context.oscillators[1]!.stop).toHaveBeenCalledWith(10.26);

    sound.dispose();

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.oscillators[0]!.disconnect).toHaveBeenCalled();
    expect(context.oscillators[1]!.disconnect).toHaveBeenCalled();
    expect(() => sound.dispose()).not.toThrow();
  });

  it("resumes a suspended context before playing", async () => {
    const context = new FakeAudioContext();
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return context;
      }
    });
    const sound = createCompletionSound();

    await sound.unlock();
    context.state = "suspended";
    sound.play();

    await vi.waitFor(() => expect(context.oscillators).toHaveLength(2));
    expect(context.resume).toHaveBeenCalledTimes(2);
    sound.dispose();
  });

  it("does not schedule sound when autoplay unlock fails", async () => {
    const context = new FakeAudioContext();
    context.resume.mockRejectedValue(new Error("autoplay blocked"));
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return context;
      }
    });
    const sound = createCompletionSound();

    await sound.unlock();
    sound.play();

    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(context.oscillators).toHaveLength(0);
    sound.dispose();
  });

  it("does not schedule sound when disposed while resume is pending", async () => {
    const context = new FakeAudioContext();
    let finishResume = () => undefined;
    context.resume.mockImplementation(() => new Promise<void>((resolve) => {
      finishResume = () => {
        context.state = "running";
        resolve();
      };
    }));
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return context;
      }
    });
    const sound = createCompletionSound();

    sound.play();
    expect(context.resume).toHaveBeenCalledTimes(1);
    sound.dispose();
    finishResume();
    await Promise.resolve();
    await Promise.resolve();

    expect(context.oscillators).toHaveLength(0);
  });
});
