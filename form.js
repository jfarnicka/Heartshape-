/*
 * form.js — the picture: one person's heart as a luminous 3D body.
 *
 * Two ECG leads look at the heart's electrical activity from two directions.
 * Plotted against each other, one beat traces a loop (the idea behind the
 * vectorcardiogram). Here every beat is wrapped once around a ring:
 *   lead II  → height
 *   2nd lead → distance from the ring's centre
 *   time     → angle around the ring
 * 40 real beats from 5 minutes each get their own ring, every one turned a
 * little further, so their QRS spikes stand around the axis like a crown.
 * The crown's spikes rise and fall with the R wave, which changes with
 * breathing; where the heart varies, the body frays.
 * The current beat lights up and a comet runs along it at the person's real
 * RR interval, then moves on to the next ring. The body breathes at their
 * breathing rate.
 */

const form = {
  person: null,
  yaw: 0.6, pitch: 0.42, dragYaw: 0, dragPitch: 0,
  clockStart: 0, beatIdx: 0, beatStart: 0,
  rings: [],
  dust: [],
  currentRing: 0,
};

function prepareForm(p) {
  form.person = p;
  const [m1, m2] = p.median;
  const scale = 1 / Math.max(...m1.map(Math.abs), ...m2.map(Math.abs));
  form.scale = scale;
  form.n = m1.length;
  form.hue = ((69 + 12 * Math.log2(tuning(p).tonic * 4 / 440)) * 30) % 360;   // colour from the tuning
  // ambient dust: points sampled from all beats
  form.dust = [];
  for (let k = 0; k < 420; k++) {
    const b = p.loopBeats[k % p.loopBeats.length];
    const i = Math.floor(Math.random() * form.n);
    form.dust.push({ b, i, rot: ((k % p.loopBeats.length) / p.loopBeats.length) * Math.PI * 2, tw: Math.random() * Math.PI * 2, off: (Math.random() - 0.5) * 0.08 });
  }
  form.beatIdx = Math.floor(Math.random() * (p.rr.length - 5));
  form.beatStart = performance.now() / 1000;
  form.rings = [];
}

// 3D point for sample i of a beat (two leads), turned by `rot` around the axis
function point(l1, l2, i, breath, rot = 0) {
  const theta = (i / form.n) * Math.PI * 2 - Math.PI / 2 + rot;
  const r = (1 + 0.55 * l2[i] * form.scale) * breath;
  return [Math.cos(theta) * r, -l1[i] * form.scale * 0.85 * breath, Math.sin(theta) * r];
}

function project([x, y, z], W, H) {
  const cy = Math.cos(form.yaw + form.dragYaw), sy = Math.sin(form.yaw + form.dragYaw);
  const cp = Math.cos(form.pitch + form.dragPitch), sp = Math.sin(form.pitch + form.dragPitch);
  const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
  const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
  const d = 4.2, f = Math.min(W, H) * 0.95 / (d - z2);
  return [W / 2 + x1 * f, H / 2 + y1 * f, z2];
}

function drawForm(ctx, W, H, t, level, beatPhase, newBeat) {
  const p = form.person;
  const breath = 1 + 0.045 * Math.sin(2 * Math.PI * (p.respRSA / 60) * t);
  form.yaw += 0.0016;
  const hue = form.hue;

  // background: near-black with a faint warm-cold vignette
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(3,3,5,0.38)";                       // partial clear = soft motion trails
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = "lighter";
  ctx.lineJoin = "round";

  // 40 beats, each on its own turned ring: the crown
  const count = p.loopBeats.length;
  const current = form.currentRing % count;
  p.loopBeats.forEach(([l1, l2], k) => {
    const rot = (k / count) * Math.PI * 2;
    ctx.strokeStyle = `hsla(${hue + (k % 5) * 3}, 55%, 70%, ${0.07 + level * 0.06})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < form.n; i++) {
      const [sx, sy] = project(point(l1, l2, i, breath, rot), W, H);
      if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
    }
    ctx.closePath();
    ctx.stroke();
  });

  // the current beat: a wide soft glow, then a fine bright core, brighter at the front
  const [m1, m2] = p.loopBeats[current];
  const curRot = (current / count) * Math.PI * 2;
  const pts = [];
  for (let i = 0; i < form.n; i++) pts.push(project(point(m1, m2, i, breath, curRot), W, H));
  ctx.lineWidth = 9;
  ctx.strokeStyle = `hsla(${hue}, 70%, 60%, 0.035)`;
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
  for (let i = 0; i < form.n; i++) {
    const a = pts[i], b = pts[(i + 1) % form.n];
    const front = (a[2] + 1.6) / 3.2;
    ctx.strokeStyle = `hsla(${hue}, 40%, ${78 + front * 18}%, ${0.25 + front * 0.6})`;
    ctx.lineWidth = 0.8 + front * 1.2;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }

  // dust that twinkles with the sound
  form.dust.forEach((d) => {
    const [x, y] = project(point(d.b[0], d.b[1], d.i, breath + d.off, d.rot), W, H);
    const s = 0.6 + 1.6 * Math.max(0, Math.sin(d.tw + t * 1.3)) * (0.4 + level);
    ctx.fillStyle = `hsla(${hue + 20}, 60%, 80%, 0.35)`;
    ctx.fillRect(x, y, s, s);
  });

  // the comet: where in the cardiac cycle we are right now
  const head = beatPhase * form.n;
  for (let k = 0; k < 26; k++) {
    const pos = head - k * 0.55;
    const i = ((Math.floor(pos) % form.n) + form.n) % form.n;
    const [x, y] = pts[i];
    const fade = 1 - k / 26;
    ctx.fillStyle = `hsla(${hue - 10}, 90%, ${70 + fade * 25}%, ${fade * 0.9})`;
    const r = (k === 0 ? 3.2 : 2.2) * fade + level * 2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // a faint ring that spreads from the body at every beat; then move to the next ring
  if (newBeat) { form.rings.push({ t0: t }); form.currentRing++; }
  form.rings = form.rings.filter((r) => t - r.t0 < 2.4);
  form.rings.forEach((r) => {
    const age = (t - r.t0) / 2.4;
    ctx.strokeStyle = `hsla(${hue}, 50%, 75%, ${(1 - age) * 0.12})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const th = (i / 64) * Math.PI * 2;
      const rr = (1.15 + age * 0.9) * breath;
      const [x, y] = project([Math.cos(th) * rr, 0.9, Math.sin(th) * rr], W, H);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  });
  ctx.globalCompositeOperation = "source-over";
}
