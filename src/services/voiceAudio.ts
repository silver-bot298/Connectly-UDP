/**
 * Real-time Voice-over-UDP Audio Engine
 * Encodes microphone audio into 8 kHz G.711 mu-law 40ms frames (~320 bytes raw / ~428 bytes Base64)
 * so every voice packet fits comfortably inside a single UDP datagram (< 1400 B MTU).
 * Plays incoming mu-law frames through a Web Audio API jitter buffer.
 */

const TARGET_SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 320; // 40ms @ 8 kHz = 25 datagrams/sec
const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;

function linearToMuLaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, sample | 0));
  let sign = 0;
  if (s < 0) {
    sign = 0x80;
    s = -s;
  }
  if (s > MU_LAW_CLIP) s = MU_LAW_CLIP;
  s += MU_LAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // find highest set bit
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawToLinear(muByte: number): number {
  const mu = ~muByte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + MU_LAW_BIAS) << exponent;
  sample -= MU_LAW_BIAS;
  return sign !== 0 ? -sample : sample;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export class VoiceUdpEngine {
  private captureCtx: AudioContext | null = null;
  private playbackCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sinkGain: GainNode | null = null;

  private toneTimer: number | null = null;
  private ringTimer: number | null = null;

  private muted = false;
  private testToneActive = false;
  private seq = 0;
  private tonePhase = 0;
  private sampleBuffer: number[] = [];
  private nextPlayTime = 0;
  private onFrameCallback: ((b64: string, seq: number, rmsLevel: number) => void) | null = null;

  public async startCapture(
    onFrame: (b64: string, seq: number, rmsLevel: number) => void
  ): Promise<{ micGranted: boolean; error?: string }> {
    this.onFrameCallback = onFrame;
    this.seq = 0;
    this.sampleBuffer = [];

    // Ensure playback context exists too
    this.ensurePlaybackContext();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.mediaStream = stream;

      const ctx = new AudioContext();
      this.captureCtx = ctx;
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);
      this.sourceNode = source;

      // 2048 samples @ 48kHz ~= 42ms per callback
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      this.processorNode = processor;

      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      this.sinkGain = silentGain;

      const inputRate = ctx.sampleRate;
      const ratio = inputRate / TARGET_SAMPLE_RATE;

      processor.onaudioprocess = (ev) => {
        if (this.testToneActive) return;
        const input = ev.inputBuffer.getChannelData(0);

        if (this.muted) {
          // Send quiet comfort noise / skip TX when muted
          return;
        }

        // Downsample linearly to 8 kHz
        let sumSq = 0;
        let count = 0;
        for (let pos = 0; pos < input.length; pos += ratio) {
          const idx = Math.floor(pos);
          const frac = pos - idx;
          const s0 = input[idx] || 0;
          const s1 = input[Math.min(idx + 1, input.length - 1)] || s0;
          const sample = s0 + (s1 - s0) * frac;
          sumSq += sample * sample;
          count++;
          this.sampleBuffer.push(sample);
        }

        const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;

        while (this.sampleBuffer.length >= FRAME_SAMPLES) {
          const chunk = this.sampleBuffer.splice(0, FRAME_SAMPLES);
          const encoded = new Uint8Array(FRAME_SAMPLES);
          for (let i = 0; i < FRAME_SAMPLES; i++) {
            encoded[i] = linearToMuLaw(chunk[i] * 32767);
          }
          this.seq += 1;
          this.onFrameCallback?.(bytesToBase64(encoded), this.seq, rms);
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);

      return { micGranted: true };
    } catch (err) {
      return {
        micGranted: false,
        error:
          err instanceof Error
            ? err.message
            : "Microphone permission denied or unavailable.",
      };
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
  }

  public setTestTone(enabled: boolean): void {
    this.testToneActive = enabled;
    if (this.toneTimer !== null) {
      window.clearInterval(this.toneTimer);
      this.toneTimer = null;
    }
    if (!enabled) return;

    this.toneTimer = window.setInterval(() => {
      if (this.muted || !this.onFrameCallback) return;
      const encoded = new Uint8Array(FRAME_SAMPLES);
      const freq = 440;
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        // Gentle pulsed tone (0.25 amplitude) so it's pleasant during demo
        const env = (this.seq % 25) < 15 ? 0.22 : 0.02;
        const val = Math.sin(this.tonePhase) * env;
        this.tonePhase += (2 * Math.PI * freq) / TARGET_SAMPLE_RATE;
        encoded[i] = linearToMuLaw(val * 32767);
      }
      this.seq += 1;
      this.onFrameCallback(bytesToBase64(encoded), this.seq, 0.22);
    }, 40);
  }

  private ensurePlaybackContext(): AudioContext {
    if (!this.playbackCtx || this.playbackCtx.state === "closed") {
      this.playbackCtx = new AudioContext();
      this.nextPlayTime = 0;
    }
    if (this.playbackCtx.state === "suspended") {
      this.playbackCtx.resume().catch(() => {});
    }
    return this.playbackCtx;
  }

  public playFrame(audioB64: string): number {
    try {
      const bytes = base64ToBytes(audioB64);
      if (bytes.length === 0) return 0;

      const ctx = this.ensurePlaybackContext();
      const buffer = ctx.createBuffer(1, bytes.length, TARGET_SAMPLE_RATE);
      const channel = buffer.getChannelData(0);

      let sumSq = 0;
      for (let i = 0; i < bytes.length; i++) {
        const sample = muLawToLinear(bytes[i]) / 32768;
        channel[i] = sample;
        sumSq += sample * sample;
      }

      const now = ctx.currentTime;
      // 60ms jitter buffer cushion; reset if fallen behind or drifted > 250ms
      if (this.nextPlayTime < now || this.nextPlayTime > now + 0.28) {
        this.nextPlayTime = now + 0.06;
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(this.nextPlayTime);
      this.nextPlayTime += buffer.duration;

      return Math.sqrt(sumSq / bytes.length);
    } catch {
      return 0;
    }
  }

  public startRingtone(mode: "incoming" | "outgoing"): void {
    this.stopRingtone();
    const playPulse = () => {
      try {
        const ctx = this.ensurePlaybackContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = mode === "incoming" ? 523.25 : 440;
        const t = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.045, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.36);
      } catch {
        // ignore audio autoplay block before gesture
      }
    };

    playPulse();
    this.ringTimer = window.setInterval(playPulse, mode === "incoming" ? 1600 : 2200);
  }

  public stopRingtone(): void {
    if (this.ringTimer !== null) {
      window.clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
  }

  public stop(): void {
    this.stopRingtone();
    this.setTestTone(false);
    this.onFrameCallback = null;

    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {
        // ignore
      }
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
    if (this.sinkGain) {
      try {
        this.sinkGain.disconnect();
      } catch {
        // ignore
      }
      this.sinkGain = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.captureCtx) {
      this.captureCtx.close().catch(() => {});
      this.captureCtx = null;
    }
    if (this.playbackCtx) {
      this.playbackCtx.close().catch(() => {});
      this.playbackCtx = null;
    }
    this.nextPlayTime = 0;
  }
}
