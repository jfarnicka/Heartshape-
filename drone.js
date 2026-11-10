/*
 * drone.js — the sound: a granular drone made from one person's ECG.
 *
 * 1. THE MATERIAL. 12 s of the person's own lead II, played much faster, so that
 *    the heartbeat itself becomes a pitch: a heart at 60 bpm beats at 1 Hz;
 *    sped up 64×, each beat lasts 1/64 s and the ECG becomes a 64 Hz tone whose
 *    timbre IS the shape of the beat.
 * 2. THE CLOUD. Thousands of tiny "grains" (short slices of that sound, each
 *    with a soft fade in and out) are layered at different pitches. Grain
 *    length, density, pitch set, detuning and stereo width all come from this
 *    person's measurements.
 * 3. THE BREATH. A filter opens and closes at the person's own breathing rate
 *    (estimated from the ECG), so the whole texture breathes with them.
 * 4. THE HEARTBEAT, not as a drum but as an event in three parts, placed at the
 *    person's real RR intervals and their measured PR and QT:
 *      P wave   a faint high shimmer, one PR interval before the beat
 *      QRS      a low pressure bloom with an attack as long as the QRS
 *      T wave   a soft swell at the T peak, as tall as the T wave
 */

const drone = { ac: null, running: false, person: null, nodes: null, timer: null, analyser: null };

function tuning(person) {
  const heartHz = person.hr / 60;
  let speed = 1;
  while (heartHz * speed < 55) speed *= 2;      // tonic between 55 and 110 Hz
  return { heartHz, speed, tonic: heartHz * speed };
}

// Pitch sets as frequency ratios, from open and calm to tense.
// Chosen by LF/HF: the balance of slower (LF) and breathing-linked (HF)
// heart-rate oscillations. Low LF/HF → vagal, relaxed; high → more sympathetic.
const INTERVAL_SETS = [
  { upTo: 0.6, name: "open fifths", ratios: [1, 1.5, 2, 3, 4] },
  { upTo: 1.5, name: "fourths and fifths", ratios: [1, 4 / 3, 1.5, 2, 8 / 3] },
  { upTo: 3, name: "seconds added", ratios: [1, 9 / 8, 1.5, 2, 9 / 4] },
  { upTo: Infinity, name: "semitones, tritone", ratios: [1, 16 / 15, 45 / 32, 15 / 8, 2] },
];

// Everything the sound takes from the person, in one place (also shown in the Reading panel).
function soundParams(p) {
  const t = tuning(p);
  return {
    ...t,
    grainMs: Math.round(Math.max(40, Math.min(160, p.qrs * 1.5))),       // 1.5 × QRS
    density: Math.round(12 + p.rmssd / 3),                               // grains per second
    intervals: INTERVAL_SETS.find((s) => p.lfhf < s.upTo),
    detuneCents: Math.round((1 - p.shapeMean) * 800),                    // unstable beat shape → wider detune
    spread: Math.min(1, p.sdnn / 100),                                     // stereo width
    breathHz: p.respRSA / 60,
    breathDepth: Math.min(1, Math.sqrt(p.hf) / 60),
    pGain: Math.min(1, p.pAmp / 0.25),
    tGain: Math.min(1, Math.abs(p.tAmp) / 0.8),
  };
}

// The ECG, resampled so one heartbeat lasts exactly one period of the tonic.
function ecgBuffer(ac, p, speed) {
  const src = p.audio, fsIn = p.fs * speed;               // samples per second after speeding up
  const n = Math.floor(src.length / fsIn * ac.sampleRate);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const x = i * fsIn / ac.sampleRate, a = Math.floor(x), f = x - a;
    d[i] = (src[a] + ((src[a + 1] ?? src[a]) - src[a]) * f) * 0.9;
  }
  return buf;
}

// A reverb made from decaying noise: no files needed.
function makeReverb(ac, seconds) {
  const len = Math.floor(ac.sampleRate * seconds);
  const ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  const conv = ac.createConvolver();
  conv.buffer = ir;
  return conv;
}

const HANN = (() => { const n = 64, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); return c; })();

function startDrone(person) {
  stopDrone();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("This browser can't play generated sound.");
  if (!drone.ac) drone.ac = new AC();
  const ac = drone.ac;
  if (ac.state === "suspended") ac.resume();

  const sp = soundParams(person);
  const buffer = ecgBuffer(ac, person, sp.speed);

  // ---- signal chain: grains → breathing filter → (dry + reverb) → compressor → out
  const master = ac.createGain(); master.gain.value = 0.0001;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.4;
  const analyser = ac.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.8;
  master.connect(comp); comp.connect(analyser); analyser.connect(ac.destination);

  const reverb = makeReverb(ac, 4.5);
  const wet = ac.createGain(); wet.gain.value = 0.55;
  reverb.connect(wet); wet.connect(master);
  const dry = ac.createGain(); dry.gain.value = 0.6; dry.connect(master);

  const breath = ac.createBiquadFilter();
  breath.type = "lowpass"; breath.Q.value = 3; breath.frequency.value = 900;
  breath.connect(dry); breath.connect(reverb);
  // the breathing LFO moves the filter between ~400 Hz and ~2.6 kHz
  const lfo = ac.createOscillator(), lfoGain = ac.createGain();
  lfo.frequency.value = sp.breathHz;
  lfoGain.gain.value = 300 + 1100 * sp.breathDepth;
  lfo.connect(lfoGain); lfoGain.connect(breath.frequency);
  breath.frequency.value = 600 + 900 * sp.breathDepth;
  lfo.start();

  const grainBus = ac.createGain(); grainBus.gain.value = 0.5; grainBus.connect(breath);
  const pulseBus = ac.createGain(); pulseBus.gain.value = 0.9; pulseBus.connect(dry); pulseBus.connect(reverb);

  const now = ac.currentTime;
  master.gain.setTargetAtTime(0.9, now, 1.2);                         // slow fade in

  // ---- schedulers
  let nextGrain = now + 0.05;
  let beatIdx = Math.floor(Math.random() * Math.max(1, person.rr.length - 20));
  let nextBeat = now + 0.4;
  const beatTimes = [];
  drone.beatLog = [];

  function grain(t, rateMul, gain, len, pan) {
    const s = ac.createBufferSource();
    s.buffer = buffer;
    s.loop = true;                       // the sped-up ECG is short (12 s ÷ 64), so grains wrap around
    s.playbackRate.value = rateMul;
    const g = ac.createGain();
    g.gain.value = 0;
    g.gain.setValueCurveAtTime(HANN.map((v) => v * gain), t, len);
    const pn = ac.createStereoPanner ? ac.createStereoPanner() : null;
    s.connect(g);
    if (pn) { pn.pan.value = pan; g.connect(pn); pn.connect(grainBus); } else g.connect(grainBus);
    const offset = Math.random() * buffer.duration;
    s.start(t, offset);
    s.stop(t + len + 0.01);
  }

  function boostAt(t) {
    // grains thicken right after each heartbeat and thin out again over 150 ms
    let b = 0;
    for (const bt of beatTimes) if (t >= bt) b = Math.max(b, Math.exp(-(t - bt) / 0.15));
    return b;
  }

  function beatEvent(t) {
    // QRS: a pressure bloom at half the tonic
    const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = sp.tonic / 2;
    o2.frequency.value = sp.tonic; o2.type = "triangle";
    const att = person.qrs / 1000, dec = person.qt / 1000;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.32, t + att);
    g.gain.exponentialRampToValueAtTime(0.0008, t + att + dec * 1.6);
    o.connect(g); o2.connect(g); g.connect(pulseBus);
    o.start(t); o2.start(t); o.stop(t + att + dec * 1.7); o2.stop(t + att + dec * 1.7);

    // P wave: a high shimmer of 5 grains, one PR interval earlier
    const pt = t - person.pr / 1000;
    if (pt > ac.currentTime) {
      for (let k = 0; k < 5; k++) grain(pt + k * 0.012, 8 * sp.intervals.ratios[k % 3], 0.05 * sp.pGain, 0.06, (Math.random() - 0.5) * 1.6);
    }

    // T wave: a soft, filtered swell at the T peak, as strong as the T wave is tall
    const tt = t + person.marks.tPeak / 1000;
    for (let k = 0; k < 4; k++) grain(tt + k * 0.03, sp.intervals.ratios[1 + (k % 2)], 0.18 * sp.tGain, 0.22, (Math.random() - 0.5) * sp.spread);
    beatTimes.push(t);
    if (beatTimes.length > 6) beatTimes.shift();
  }

  drone.timer = setInterval(() => {
    const horizon = ac.currentTime + 0.12;
    while (nextBeat < horizon + 0.6) {        // beats are booked further ahead (for the P shimmer)
      const rr = person.rr[beatIdx % person.rr.length] / 1000;
      beatEvent(nextBeat);
      drone.beatLog.push({ t: nextBeat, rr, idx: beatIdx % person.rr.length });
      if (drone.beatLog.length > 8) drone.beatLog.shift();
      nextBeat += rr;
      beatIdx++;
    }
    while (nextGrain < horizon) {
      const ratio = sp.intervals.ratios[Math.floor(Math.random() * sp.intervals.ratios.length)];
      const cents = (Math.random() * 2 - 1) * sp.detuneCents;
      const len = sp.grainMs / 1000 * (0.7 + Math.random() * 0.6);
      const gain = 0.16 + 0.22 * boostAt(nextGrain);
      grain(nextGrain, ratio * Math.pow(2, cents / 1200), gain, len, (Math.random() * 2 - 1) * sp.spread);
      const density = sp.density * (1 + 1.5 * boostAt(nextGrain));
      nextGrain += (1 / density) * (0.5 + Math.random());
    }
  }, 25);

  drone.running = true;
  drone.person = person;
  drone.analyser = analyser;
  drone.nodes = { master, lfo };
  drone.beatIdx = () => beatIdx;
  drone.params = sp;
}

function stopDrone() {
  clearInterval(drone.timer);
  drone.timer = null;
  if (drone.nodes) {
    const { master, lfo } = drone.nodes, t = drone.ac.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(0.0001, t, 0.25);
    setTimeout(() => { try { master.disconnect(); lfo.stop(); } catch (e) { /* gone */ } }, 1500);
  }
  drone.nodes = null;
  drone.running = false;
  drone.analyser = null;
}

// Loudness right now, 0..1, for the visuals.
const levelBuf = new Uint8Array(512);
function droneLevel() {
  if (!drone.analyser) return 0;
  drone.analyser.getByteTimeDomainData(levelBuf);
  let s = 0;
  for (let i = 0; i < levelBuf.length; i++) { const v = (levelBuf[i] - 128) / 128; s += v * v; }
  return Math.min(1, Math.sqrt(s / levelBuf.length) * 3);
}
