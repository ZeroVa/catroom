/**
 * pspsps-detector.ts — v2
 * Key changes:
 *  - Mic DSP off by default (keeps plosive bursts intact)
 *  - Analyser smoothing ↓ (0.2) and fftSize ↓ (1024) for snappier peaks
 *  - Adds high-band spectral flux (onset) + adaptive thresholding
 *  - Wider rhythm window; allow 2+ peaks; looser cadence tolerance
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// pspsps-detector.ts — v3 (iOS-friendly)
// Adds sustained-hiss fallback using Zero-Crossing Rate (ZCR).
export type DetectorOptions = {
    fftSize: number;
    hiBandHz: [number, number];
    loBandHz: [number, number];
    envelopeWindow: number;
    kStd: number;
    ratioDbFloor: number;
    hiDbFloor: number;
    minPeaks: number;
    patternWindowMs: number;
    minInterPeakMs: number;
    maxInterPeakMs: number;
    cooldownMs: number;
    smoothingTimeConstant: number;
    debug: boolean;
    sensitivity: number;
    // spectral flux
    fluxWindow: number;
    fluxKStd: number;
    fluxFloor: number;
    // mic DSP toggles
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
    // NEW: sustained-hiss fallback
    hissFallbackMs: number;   // how long a hiss must persist to trigger
    hissRatioFloor: number;   // smaller than ratioDbFloor (easier gate)
    zcrWindow: number;        // samples in ZCR smoothing window
    zcrThresh: number;        // ~0.16–0.24 works well on phones
  };
  
  export class PspspsDetector extends EventTarget {
    private ctx!: AudioContext;
    private analyser!: AnalyserNode;
    private src?: MediaStreamAudioSourceNode;
    private stream?: MediaStream;
  
    private freqData!: Float32Array;
    private prevFreq!: Float32Array;
    private timeData!: Uint8Array;      // for ZCR
    private rafId: number | null = null;
  
    private options: DetectorOptions;
    private envelope: number[] = [];
    private peaks: number[] = [];
    private lastPeak = -Infinity;
    private lastFire = -Infinity;
  
    private fluxEnv: number[] = [];
    private zcrEnv: number[] = [];
    private hissStartMs = -1;
  
    private binHz = 0;
    private hiStart = 0; private hiEnd = 0;
    private loStart = 0; private loEnd = 0;
  
    private debugEl?: HTMLDivElement;
    private spark?: HTMLCanvasElement;
    private sparkData: number[] = [];
  
    constructor(opts?: Partial<DetectorOptions>) {
      super();
      this.options = {
        // snappy defaults
        fftSize: 1024,
        hiBandHz: [3200, 9500],
        loBandHz: [80, 1500],
        envelopeWindow: 48,
        kStd: 0.9,
        ratioDbFloor: 3.5,
        hiDbFloor: -65,
        minPeaks: 2,
        patternWindowMs: 1600,
        minInterPeakMs: 60,
        maxInterPeakMs: 360,
        cooldownMs: 1400,
        smoothingTimeConstant: 0.18,
        debug: false,
        sensitivity: 1.2,
  
        // flux
        fluxWindow: 48,
        fluxKStd: 1.0,
        fluxFloor: 3.0,
  
        // mic DSP off unless you also play sounds
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
  
        // NEW: sustained hiss
        hissFallbackMs: 420,     // iOS likes ~350–500ms
        hissRatioFloor: 1.6,     // easier than ratioDbFloor
        zcrWindow: 24,           // ~0.4s smoothing
        zcrThresh: 0.20,         // phones often land ~0.18–0.25 on “ssss”
        ...opts,
      };
    }
  
    static async create(opts?: Partial<DetectorOptions>) {
      const d = new PspspsDetector(opts);
      await d.init();
      return d;
    }
  
    get mediaStream() { return this.stream; }
  
    async init() {
      if (this.ctx) return;
      // @ts-ignore
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: this.options.echoCancellation,
            noiseSuppression: this.options.noiseSuppression,
            autoGainControl: this.options.autoGainControl,
          },
        });
      } catch (err) {
        throw new Error(`Mic permission failed: ${String(err)}`);
      }
  
      this.src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.options.fftSize;
      this.analyser.smoothingTimeConstant = this.options.smoothingTimeConstant;
      this.analyser.minDecibels = -100;
      this.analyser.maxDecibels = -30;
      this.src.connect(this.analyser);
  
      this.freqData = new Float32Array(this.analyser.frequencyBinCount);
      this.prevFreq = new Float32Array(this.analyser.frequencyBinCount);
      this.timeData = new Uint8Array(this.analyser.fftSize);
      this.binHz = this.ctx.sampleRate / this.analyser.fftSize;
  
      const [hiLo, hiHi] = this.options.hiBandHz;
      const [loLo, loHi] = this.options.loBandHz;
      this.hiStart = Math.max(0, Math.floor(hiLo / this.binHz));
      this.hiEnd   = Math.min(this.freqData.length - 1, Math.floor(hiHi / this.binHz));
      this.loStart = Math.max(0, Math.floor(loLo / this.binHz));
      this.loEnd   = Math.min(this.freqData.length - 1, Math.floor(loHi / this.binHz));
  
      if (this.options.debug) this.mountDebug();
    }
  
    async start() {
      if (!this.ctx) await this.init();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (this.rafId !== null) return;
      const loop = () => { this.tick(); this.rafId = requestAnimationFrame(loop); };
      this.rafId = requestAnimationFrame(loop);
    }
  
    stop() { if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; } }
  
    destroy() {
      this.stop();
      try { this.src?.disconnect(); } catch {}
      try { this.analyser?.disconnect(); } catch {}
      try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
      try { if (this.ctx && this.ctx.state !== 'closed') this.ctx.close(); } catch {}
      if (this.debugEl?.parentElement) this.debugEl.parentElement.removeChild(this.debugEl);
      // @ts-ignore
      this.ctx = undefined;
    }
  
    private bandDb(start: number, end: number) {
      let sum = 0;
      for (let i = start; i <= end; i++) sum += Math.max(this.freqData[i], -100);
      return sum / (end - start + 1);
    }
  
    private spectralFluxHiBand(): number {
      let flux = 0;
      for (let i = this.hiStart; i <= this.hiEnd; i++) {
        const d = this.freqData[i] - this.prevFreq[i];
        if (d > 0) flux += d;
        this.prevFreq[i] = this.freqData[i];
      }
      return flux;
    }
  
    private zeroCrossingRate(): number {
      this.analyser.getByteTimeDomainData(this.timeData);
      let zc = 0;
      let prev = this.timeData[0] - 128;
      for (let i = 1; i < this.timeData.length; i++) {
        const v = this.timeData[i] - 128;
        // sign change -> crossing
        if ((v >= 0) !== (prev >= 0)) zc++;
        prev = v;
      }
      return zc / this.timeData.length; // 0..~0.5
    }
  
    private tick() {
      this.analyser.getFloatFrequencyData(this.freqData);
  
      const hi = this.bandDb(this.hiStart, this.hiEnd);
      const lo = this.bandDb(this.loStart, this.loEnd);
      const ratioDb = hi - lo;
  
      // Adaptive hi-band envelope
      this.envelope.push(hi);
      if (this.envelope.length > this.options.envelopeWindow) this.envelope.shift();
      const mean = this.envelope.reduce((a, b) => a + b, 0) / this.envelope.length;
      const std = Math.sqrt(this.envelope.reduce((a, b) => a + (b - mean) ** 2, 0) / this.envelope.length);
      const sens = this.options.sensitivity;
      const threshHi = mean + (this.options.kStd / sens) * std;
  
      // Spectral flux envelope
      const flux = this.spectralFluxHiBand();
      this.fluxEnv.push(flux);
      if (this.fluxEnv.length > this.options.fluxWindow) this.fluxEnv.shift();
      const fMean = this.fluxEnv.reduce((a, b) => a + b, 0) / this.fluxEnv.length;
      const fStd = Math.sqrt(this.fluxEnv.reduce((a, b) => a + (b - fMean) ** 2, 0) / this.fluxEnv.length);
      const threshFlux = fMean + (this.options.fluxKStd / sens) * fStd;
  
      // Zero-crossing rate (fricatives hiss high ZCR)
      const zcr = this.zeroCrossingRate();
      this.zcrEnv.push(zcr);
      if (this.zcrEnv.length > this.options.zcrWindow) this.zcrEnv.shift();
      const zcrSmoothed = this.zcrEnv.reduce((a, b) => a + b, 0) / this.zcrEnv.length;
  
      const now = performance.now();
      const refractory = Math.max(55, this.options.minInterPeakMs * 0.6);
  
      // Rhythm peaks: envelope OR flux pop
      const hiPop   = hi   > Math.max(threshHi, this.options.hiDbFloor);
      const fluxPop = flux > Math.max(threshFlux, this.options.fluxFloor);
  
      if ((hiPop || fluxPop) && ratioDb > (this.options.ratioDbFloor / sens) && (now - this.lastPeak) > refractory) {
        this.peaks.push(now);
        this.lastPeak = now;
      }
      while (this.peaks.length && (now - this.peaks[0]) > this.options.patternWindowMs) this.peaks.shift();
  
      // --------- PATH A: rhythm (ps-ps-ps) ----------
      let shouldFire = false;
      if (this.peaks.length >= this.options.minPeaks) {
        const ok = this.peaks.slice(1).every((t, i) => {
          const dt = t - this.peaks[i];
          return dt > this.options.minInterPeakMs && dt < this.options.maxInterPeakMs;
        });
        if (ok) shouldFire = true;
      }
  
      // --------- PATH B: sustained hiss fallback ----------
      const hissGate = (ratioDb > (this.options.hissRatioFloor / sens)) && (zcrSmoothed > this.options.zcrThresh);
      if (hissGate) {
        if (this.hissStartMs < 0) this.hissStartMs = now;
        if (!shouldFire && (now - this.hissStartMs) >= this.options.hissFallbackMs) {
          shouldFire = true;
        }
      } else {
        this.hissStartMs = -1;
      }
  
      if (shouldFire && (now - this.lastFire) > this.options.cooldownMs) {
        this.lastFire = now;
        const evt = new CustomEvent('pspsps-detected');
        window.dispatchEvent(evt);
        this.dispatchEvent(evt);
        this.peaks.length = 0;
        this.hissStartMs = -1;
      }
  
      if (this.options.debug) this.updateDebug({ hi, lo, ratioDb, mean, std, flux, fMean, fStd, zcrSmoothed, detected: shouldFire });
    }
  
    /* -------------------- Debug UI -------------------- */
    private mountDebug() {
      const d = document.createElement('div');
      d.style.position = 'fixed';
      d.style.right = '12px';
      d.style.bottom = '12px';
      d.style.zIndex = '2147483647';
      d.style.background = 'rgba(0,0,0,0.72)';
      d.style.color = '#fff';
      d.style.fontFamily = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      d.style.fontSize = '12px';
      d.style.padding = '10px 12px';
      d.style.borderRadius = '10px';
      d.style.backdropFilter = 'blur(6px)';
      d.style.boxShadow = '0 6px 24px rgba(0,0,0,0.3)';
  
      const header = document.createElement('div');
      header.textContent = 'pspsps detector';
      header.style.fontWeight = '600';
      header.style.marginBottom = '6px';
  
      const row = (label: string) => {
        const el = document.createElement('div');
        el.innerHTML = `<span style="opacity:.7">${label}</span> <span data-v="${label}">–</span>`;
        el.style.whiteSpace = 'nowrap';
        return el;
      };
  
      const fields = ['hi(dB)','lo(dB)','hi-lo(dB)','mean(dB)','std(dB)','flux','zcr','peaks'];
      const rows: Record<string, HTMLSpanElement> = {} as any;
      d.appendChild(header);
      fields.forEach(f => { const el = row(f); rows[f] = el.querySelector('span[data-v]') as HTMLSpanElement; d.appendChild(el); });
  
      const spark = document.createElement('canvas');
      spark.width = 260; spark.height = 42;
      spark.style.display = 'block'; spark.style.marginTop = '8px';
      spark.style.borderRadius = '6px'; spark.style.background = 'rgba(255,255,255,0.06)';
      d.appendChild(spark);
  
      const hint = document.createElement('div');
      hint.style.opacity = '0.7'; hint.style.marginTop = '6px';
      hint.innerHTML = `<b>tips</b>: short bursts or a held hiss. zcr ≈ 0.20–0.28 on “ssss”.`;
      d.appendChild(hint);
  
      document.body.appendChild(d);
      this.debugEl = d;
      this.spark = spark as HTMLCanvasElement;
      (this as any)._debugRows = rows;
    }
  
    private updateDebug(v: { hi:number; lo:number; ratioDb:number; mean:number; std:number; flux:number; fMean:number; fStd:number; zcrSmoothed:number; detected:boolean; }) {
      if (!this.debugEl) return;
      const rows = (this as any)._debugRows as Record<string, HTMLSpanElement>;
      rows['hi(dB)'].textContent = v.hi.toFixed(1);
      rows['lo(dB)'].textContent = v.lo.toFixed(1);
      rows['hi-lo(dB)'].textContent = v.ratioDb.toFixed(1);
      rows['mean(dB)'].textContent = v.mean.toFixed(1);
      rows['std(dB)'].textContent = v.std.toFixed(2);
      rows['flux'].textContent = v.flux.toFixed(2);
      rows['zcr'].textContent = v.zcrSmoothed.toFixed(3);
      rows['peaks'].textContent = String((this as any).peaks?.length ?? 0);
  
      // sparkline: combined hi/flux
      const hiThresh = v.mean + (this.options.kStd / this.options.sensitivity) * v.std;
    //   const fluxThresh = (this as any).fluxEnv ? 0 : 0; // keep simple
      this.sparkData.push((v.hi - hiThresh) + 0.4*(v.flux));
      if (this.sparkData.length > 260) this.sparkData.shift();
  
      const ctx = this.spark!.getContext('2d')!;
      ctx.clearRect(0, 0, this.spark!.width, this.spark!.height);
      ctx.globalAlpha = 0.5; ctx.beginPath();
      ctx.moveTo(0, this.spark!.height / 2);
      ctx.lineTo(this.spark!.width, this.spark!.height / 2);
      ctx.strokeStyle = '#888'; ctx.stroke();
  
      ctx.globalAlpha = 1; ctx.beginPath();
      const mid = this.spark!.height / 2; const scale = 2.0;
      this.sparkData.forEach((val, i) => { const y = mid - val * scale; if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i, y); });
      ctx.strokeStyle = v.detected ? '#2ee' : '#fff';
      ctx.lineWidth = 2; ctx.stroke();
  
      if (v.detected) {
        this.debugEl!.style.boxShadow = '0 0 0 2px rgba(46,238,238,0.6), 0 8px 26px rgba(0,255,255,0.25)';
        setTimeout(() => { if (this.debugEl) this.debugEl.style.boxShadow = '0 6px 24px rgba(0,0,0,0.3)'; }, 160);
      }
    }
  }
  

/**
 * React hook wrapper
 */
export function usePspspsDetector(
  onDetect?: () => void,
  opts?: Partial<DetectorOptions>
) {
  const detectorRef = useRef<PspspsDetector | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stableOpts = useMemo(() => opts, []); // pass stable options (tune via controls + restart)

  const start = useCallback(async () => {
    const isIOS =
      /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    const iosTweaks = isIOS
      ? {
          // looser gates for mobile mics
          ratioDbFloor: 2.0, // was 3.5
          hiDbFloor: -75, // allow quieter hi-band
          minPeaks: 2,
          minInterPeakMs: 50,
          maxInterPeakMs: 420,
          smoothingTimeConstant: 0.05, // snappier peaks
          sensitivity: 1.5,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : {};
    try {
      if (!detectorRef.current) {
        detectorRef.current = await PspspsDetector.create({
          ...stableOpts,
          ...iosTweaks,
        });
        const handler = () => onDetect && onDetect();
        detectorRef.current.addEventListener(
          "pspsps-detected",
          handler as EventListener
        );
      }
      await detectorRef.current.start();
      setListening(true);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [onDetect, stableOpts]);

  const stop = useCallback(() => {
    detectorRef.current?.stop();
    setListening(false);
  }, []);

  useEffect(() => {
    return () => {
      detectorRef.current?.destroy();
      detectorRef.current = null;
    };
  }, []);

  return { start, stop, listening, error };
}
