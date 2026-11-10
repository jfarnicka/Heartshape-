/*
 * app.js — runs the piece: the render loop, the heartbeat clock, controls
 * and the Reading panel.
 */
"use strict";

const $ = (s) => document.querySelector(s);
const canvas = $("#stage");
const ctx = canvas.getContext("2d");
let person = PEOPLE[0];
let W = 0, H = 0;

const label = (p) => `${p.sex === "female" ? "F" : "M"}${p.age ? p.age : ""}`;

// ---------------------------------------------------------------- people
function renderPeople() {
  $("#people").innerHTML = PEOPLE.map((p, i) =>
    `<button type="button" class="person" data-i="${i}" aria-current="${p === person}">${String(i + 1).padStart(2, "0")}<small>${label(p)}</small></button>`).join("");
  document.querySelectorAll(".person").forEach((b) => b.addEventListener("click", () => choose(Number(b.dataset.i))));
}

function choose(i) {
  const wasPlaying = drone.running;
  person = PEOPLE[i];
  prepareForm(person);
  ctx.fillStyle = "#030305"; ctx.fillRect(0, 0, W, H);
  renderPeople();
  const sp = soundParams(person);
  $("#subject-line").innerHTML =
    `Subject <b>${person.id}</b> · ${person.sex}${person.age ? ", " + person.age : ""}<br>` +
    `Leads <b>${person.leads.join(" / ")}</b> · ${person.beats} beats in 5 min<br>` +
    `Tuned to <b>${sp.tonic.toFixed(1)} Hz</b> · ${sp.intervals.name}`;
  if (wasPlaying) startDrone(person);
  renderReading();
}

// ---------------------------------------------------------------- clock
// Without sound the form follows the person's real RR intervals on its own clock;
// with sound it follows the beats the audio engine has booked, so both stay in sync.
let lastBeatShown = null;
function beatState(now) {
  if (drone.running && drone.beatLog && drone.beatLog.length) {
    const at = drone.ac.currentTime;
    let cur = null;
    for (const b of drone.beatLog) if (b.t <= at) cur = b;
    if (cur) return { phase: Math.min(1, (at - cur.t) / cur.rr), idx: cur.idx, rr: cur.rr, key: cur.t };
    return { phase: 0, idx: drone.beatLog[0].idx, rr: drone.beatLog[0].rr, key: -1 };
  }
  let rr = person.rr[form.beatIdx % person.rr.length] / 1000;
  while (now - form.beatStart >= rr) {
    form.beatStart += rr;
    form.beatIdx++;
    rr = person.rr[form.beatIdx % person.rr.length] / 1000;
  }
  return { phase: (now - form.beatStart) / rr, idx: form.beatIdx % person.rr.length, rr, key: form.beatStart };
}

// ---------------------------------------------------------------- render loop
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  W = Math.round(window.innerWidth * dpr);
  H = Math.round(window.innerHeight * dpr);
  canvas.width = W; canvas.height = H;
  ctx.fillStyle = "#030305"; ctx.fillRect(0, 0, W, H);
}

function frame(ms) {
  const now = ms / 1000;
  const b = beatState(now);
  const newBeat = b.key !== lastBeatShown && b.key !== -1;
  lastBeatShown = b.key;
  drawForm(ctx, W, H, now, droneLevel(), b.phase, newBeat);
  const sp = drone.params && drone.running ? drone.params : null;
  $("#readout").innerHTML =
    `Beat <b>${String(b.idx + 1).padStart(3, "0")}</b>/${person.rr.length} · RR <b>${Math.round(b.rr * 1000)}</b> ms · ` +
    `Breath <b>${person.respRSA.toFixed(1)}</b>/min` + (sp ? ` · <b>${sp.density}</b> grains/s` : "");
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- drag to turn
let drag = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, yaw: form.dragYaw, pitch: form.dragPitch }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  wake();
  if (!drag) return;
  form.dragYaw = drag.yaw + (e.clientX - drag.x) * 0.006;
  form.dragPitch = Math.max(-1.2, Math.min(1.2, drag.pitch + (e.clientY - drag.y) * 0.006));
});
canvas.addEventListener("pointerup", () => (drag = null));

// UI fades away when nobody moves, so only the form remains
let idleTimer;
function wake() {
  $("#ui").classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!drag && $("#reading").hidden) $("#ui").classList.add("idle"); }, 4000);
}
window.addEventListener("pointermove", wake);

// ---------------------------------------------------------------- sound
function setListen(on) {
  $("#listen").setAttribute("aria-pressed", String(on));
  $("#listen-label").textContent = on ? "Stop" : "Listen";
}
$("#listen").addEventListener("click", () => {
  if (drone.running) { stopDrone(); setListen(false); return; }
  try { startDrone(person); setListen(true); }
  catch (e) { $("#readout").textContent = e.message; }
});

// ---------------------------------------------------------------- reading
function openReading(open) {
  $("#reading").hidden = !open;
  $("#reading-btn").setAttribute("aria-expanded", String(open));
  if (open) { renderReading(); $("#reading-close").focus(); wake(); }
}
$("#reading-btn").addEventListener("click", () => openReading($("#reading").hidden));
$("#reading-close").addEventListener("click", () => { openReading(false); $("#reading-btn").focus(); });

function renderReading() {
  if ($("#reading").hidden) return;
  const p = person, sp = soundParams(p);
  $("#rd-h").textContent = `Subject ${p.id}`;
  $("#rd-sub").textContent = `${p.sex}${p.age ? ", " + p.age : ", age not recorded"} · leads ${p.leads.join(" / ")} · ${p.window} · ${p.beats} beats`;
  const agree = Math.abs(p.respRSA - p.respEDR) <= 2;
  const groups = [
    ["Rhythm", [
      ["Heart rate", `${p.hr} bpm`, `Tuning: ${p.hr} bpm = ${sp.heartHz.toFixed(3)} Hz × ${sp.speed} → <b>${sp.tonic.toFixed(1)} Hz</b>. The ECG is sped up ${sp.speed}× to become the sound source.`],
      ["RR series", `${p.rr.length} intervals`, "Exact timing of every pressure bloom and of the comet's laps"],
      ["SDNN", `${p.sdnn} ms`, `Stereo width ${Math.round(sp.spread * 100)}%`],
      ["RMSSD", `${p.rmssd} ms`, `Grain density ${sp.density} per second`],
      ["pNN50", `${p.pnn50} %`, "Shown for reference"],
    ]],
    ["Autonomic balance", [
      ["LF power", `${p.lf} ms²`, "Slow oscillations (0.04–0.15 Hz)"],
      ["HF power", `${p.hf} ms²`, `Breath depth: filter swing ${Math.round(sp.breathDepth * 100)}%`],
      ["LF / HF", `${p.lfhf}`, `Pitch set: <b>${sp.intervals.name}</b> (${sp.intervals.ratios.map((r) => r.toFixed(2)).join(" · ")})`],
    ]],
    ["Breathing", [
      ["From heart rate (RSA)", `${p.respRSA} /min`, `The filter and the form breathe at ${sp.breathHz.toFixed(3)} Hz`],
      ["From R height (EDR)", `${p.respEDR} /min`, agree ? "Agrees with the RSA estimate" : `<span class="warn">Differs from RSA; RSA is used</span>`],
    ]],
    ["Waves (median beat)", [
      ["PR interval", `${p.pr} ms`, `P shimmer sounds ${p.pr} ms before each bloom`],
      ["QRS duration", `${p.qrs} ms`, `Grain length ${sp.grainMs} ms; bloom attack ${p.qrs} ms`],
      ["QT interval", `${p.qt} ms`, p.qtConfidence === "low" ? `<span class="warn">Flat T wave: QT less certain.</span> Bloom decay` : "Bloom decay"],
      ["QTc Bazett / Fridericia", `${p.qtcB} / ${p.qtcF} ms`, "Shown for reference"],
      ["P / R / T height", `${p.pAmp} / ${p.rAmp} / ${p.tAmp} mV`, `Shimmer ${Math.round(sp.pGain * 100)}% · swell ${Math.round(sp.tGain * 100)}%`],
      ["ST level", `${p.st} mV`, "Shown for reference"],
    ]],
    ["Shape", [
      ["Beat-to-beat similarity", `${p.shapeMean.toFixed(3)} ± ${p.shapeSD.toFixed(3)}`, `Detune ±${sp.detuneCents} cents; how much the 40-beat bundle frays`],
      ["Two-lead loop", `${p.leads.join(" × ")}`, "The shape of the form itself"],
    ]],
  ];
  $("#rd-tables").innerHTML = groups.map(([h, rows]) => `
    <section class="rd-group"><h3>${h}</h3>
      <table class="rd-table"><tbody>${rows.map(([a, v, d]) => `<tr><td>${a}</td><td>${v}</td><td>${d}</td></tr>`).join("")}</tbody></table>
    </section>`).join("");
  drawBeatFigure();
  drawRRFigure();
}

function fitCanvas(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth, h = c.clientHeight;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [g, w, h];
}

function drawBeatFigure() {
  const [g, w, h] = fitCanvas($("#rd-beat"));
  const [m1, m2] = person.median;
  const all = [...m1, ...m2], lo = Math.min(...all), hi = Math.max(...all);
  const x = (i) => (i / (m1.length - 1)) * w;
  const y = (v) => h - 14 - ((v - lo) / (hi - lo)) * (h - 28);
  const span = (m1.length / 125) * 1000;                    // window starts 350 ms before R
  const tx = (ms) => ((ms + 350) / span) * w;
  g.strokeStyle = "rgba(233,231,239,0.12)";
  g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke();
  const marks = person.marks;
  g.font = "9px 'Geist Mono', monospace"; g.fillStyle = "#8a879a"; g.textAlign = "center";
  [["P", marks.pOn], ["QRS", marks.qrsOn], ["J", marks.j], ["T", marks.tPeak], ["T end", marks.tEnd]].forEach(([n, ms]) => {
    if (ms < -350 || ms > span - 350) return;
    g.strokeStyle = "rgba(255,77,94,0.5)";
    g.beginPath(); g.moveTo(tx(ms), 10); g.lineTo(tx(ms), h); g.stroke();
    g.fillText(n, tx(ms), 8);
  });
  [[m2, "rgba(233,231,239,0.3)", 1], [m1, "#e9e7ef", 1.5]].forEach(([s, c, lw]) => {
    g.strokeStyle = c; g.lineWidth = lw;
    g.beginPath(); s.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke();
  });
}

function drawRRFigure() {
  const [g, w, h] = fitCanvas($("#rd-rr"));
  const rr = person.rr, lo = Math.min(...rr), hi = Math.max(...rr);
  g.strokeStyle = "#e9e7ef"; g.lineWidth = 1;
  g.beginPath();
  rr.forEach((v, i) => {
    const px = (i / (rr.length - 1)) * w, py = h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 12);
    if (i) g.lineTo(px, py); else g.moveTo(px, py);
  });
  g.stroke();
  g.fillStyle = "#4a4858"; g.font = "9px 'Geist Mono', monospace";
  g.fillText(`${hi} ms`, 2, 9); g.fillText(`${lo} ms`, 2, h - 2);
}

// ---------------------------------------------------------------- keys
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k >= "1" && k <= String(PEOPLE.length)) choose(Number(k) - 1);
  else if (k === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); $("#listen").click(); }
  else if (k === "r") openReading($("#reading").hidden);
  else if (k === "escape" && !$("#reading").hidden) openReading(false);
  else return;
  wake();
});

window.addEventListener("resize", () => { resize(); renderReading(); });

// ---------------------------------------------------------------- start
resize();
choose(0);
wake();
requestAnimationFrame(frame);
