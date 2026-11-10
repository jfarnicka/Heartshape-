"""
extract.py — the analysis behind Heartform.

For each person: 5 minutes of clean sinus rhythm from the MIT-BIH Arrhythmia
Database, both recorded leads. Produces data.js with everything the piece needs.

What is measured
  * wave boundaries on the median beat (own delineation, see delineate()):
    PR interval, QRS duration, QT interval, QTc (Bazett and Fridericia).
    NeuroKit2's beat-by-beat wavelet delineation was tried first, but gave
    implausible values on these noisy 1970s recordings (QRS up to 244 ms).
  * heart-rate variability over 5 minutes
      time domain:      mean RR, SDNN, RMSSD, pNN50
      frequency domain: LF (0.04-0.15 Hz) and HF (0.15-0.4 Hz) power, LF/HF
  * breathing rate, two independent ways:
      - the peak of the HF band of the RR series (respiratory sinus arrhythmia)
      - ECG-derived respiration: breathing moves the heart in the chest,
        so the R-wave height rises and falls with each breath
  * wave amplitudes (P, R, S, T, ST level) from the median beat of each lead
  * how stable the beat shape is: correlation of every beat with the median beat
  * 40 individual beats from both leads (for the 3D form)
  * 12 s of the raw lead II signal (the sound source)

Usage:  python extract.py path/to/mitdb  >  writes data.js next to this script
Needs:  pip install wfdb neurokit2 scipy numpy
"""

import json
import sys
from pathlib import Path

import neurokit2 as nk
import numpy as np
import wfdb
from scipy.signal import butter, filtfilt, welch

PEOPLE = [  # record, start (s): 5-minute windows containing only normal beats
    ("113", 720), ("115", 0), ("122", 0), ("123", 430), ("117", 0), ("103", 0),
]
WINDOW_S = 300
BEATS_KEPT = 40


def median_beat(sig, peaks, fs, pre=0.35, post=0.5):
    a, b = int(pre * fs), int(post * fs)
    beats = np.array([sig[p - a:p + b] for p in peaks if p - a >= 0 and p + b <= len(sig)])
    return np.median(beats, axis=0), beats



def delineate(beat, fs, pre):
    """Classic hand-made delineation of one (median) beat. Times in ms.

    baseline   the flattest 40 ms stretch before the QRS (PR or TP segment)
    QRS onset  walking back from R, where the slope drops below 10% of the QRS's steepest slope
    J point    the same, walking forward: the end of the QRS
    T end      tangent method: the steepest point on the T wave's down-slope,
               extended as a straight line until it meets the baseline
    P onset    walking back from the P peak until the signal is back within
               10% of the P amplitude of the baseline, or stops falling
    """
    r = int(pre * fs)
    ms = lambda n: n / fs * 1000
    k = lambda t: int(round(t / 1000 * fs))
    slope = np.gradient(beat) * fs
    win = k(40)
    cands = range(r - k(300), r - k(40) - win)
    flat = min(cands, key=lambda i: np.std(beat[i:i + win]))
    base = float(np.median(beat[flat:flat + win]))

    steep = np.max(np.abs(slope[r - k(60):r + k(60)]))
    on = r
    while on > r - k(120) and np.max(np.abs(slope[on - k(8):on])) > 0.1 * steep:
        on -= 1
    j = r
    while j < r + k(140) and np.max(np.abs(slope[j:j + k(8)])) > 0.1 * steep:
        j += 1

    t_zone = beat[j + k(60):j + k(420)] - base
    t_peak = j + k(60) + int(np.argmax(np.abs(t_zone)))
    t_sign = np.sign(beat[t_peak] - base)
    after = slope[t_peak:t_peak + k(200)] * t_sign          # down-slope = most negative
    m = t_peak + int(np.argmin(after))
    t_end = m + (base - beat[m]) / slope[m] * fs / fs if slope[m] != 0 else m + k(40)
    t_end = int(round(m + (base - beat[m]) / (slope[m] / fs))) if slope[m] != 0 else m + k(40)

    p_zone = beat[on - k(250):on - k(30)] - base
    p_peak = on - k(250) + int(np.argmax(p_zone))
    p_amp = beat[p_peak] - base
    p_on = p_peak
    # stop when back near the baseline OR at the low point before the P wave
    while p_on > on - k(320) and beat[p_on] - base > 0.1 * p_amp and beat[p_on - 1] < beat[p_on]:
        p_on -= 1
    t_amp = float(beat[t_peak] - base)

    return {
        "pr": round(ms(on - p_on)), "qrs": round(ms(j - on)), "qt": round(ms(t_end - on)),
        "marks": {"pOn": ms(p_on - r), "pPeak": ms(p_peak - r), "qrsOn": ms(on - r), "j": ms(j - r),
                  "tPeak": ms(t_peak - r), "tEnd": ms(t_end - r)},
        "base": base,
        # the tangent method needs a clear T wave; below 0.15 mV the T end is uncertain
        "qtConfidence": "low" if abs(t_amp) < 0.15 else "good",
    }

def band_peak(freqs, power, lo, hi):
    m = (freqs >= lo) & (freqs <= hi)
    return float(freqs[m][np.argmax(power[m])])


def analyse(mitdb, record, start_s):
    header = wfdb.rdheader(str(mitdb / record))
    fs = header.fs
    age, sex = header.comments[0].split()[:2]
    start, stop = int(start_s * fs), int((start_s + WINDOW_S) * fs)
    raw, _ = wfdb.rdsamp(str(mitdb / record), sampfrom=start, sampto=stop)
    ann = wfdb.rdann(str(mitdb / record), "atr", sampfrom=start, sampto=stop)
    peaks = np.array([s - start for s, sym in zip(ann.sample, ann.symbol) if sym == "N"])

    leads = [nk.ecg_clean(raw[:, k], sampling_rate=fs, method="neurokit") for k in range(2)]
    ecg = leads[0]

    # the expert labels sit near, not exactly on, the R peak: snap to the local maximum
    w = int(0.05 * fs)
    peaks = np.array([p - w + int(np.argmax(np.abs(ecg[max(0, p - w):p + w]))) for p in peaks if p - w >= 0])

    # ---- wave boundaries, measured on the median beat (noise averages out)
    marks = delineate(*median_beat(ecg, peaks, fs, pre=0.4, post=0.6)[:1], fs, pre=0.4)
    pr, qrs, qt, qt_conf = marks["pr"], marks["qrs"], marks["qt"], marks["qtConfidence"]

    rr = np.diff(peaks) / fs
    mean_rr = float(np.mean(rr))
    qtc_bazett = qt / np.sqrt(mean_rr)
    qtc_fridericia = qt / np.cbrt(mean_rr)

    # ---- heart-rate variability
    t_hrv = nk.hrv_time(peaks, sampling_rate=fs)
    f_hrv = nk.hrv_frequency(peaks, sampling_rate=fs, normalize=False)

    # RR series resampled evenly at 4 Hz, then its spectrum
    t_beats = peaks[1:] / fs
    grid = np.arange(t_beats[0], t_beats[-1], 0.25)
    rr_even = np.interp(grid, t_beats, rr)
    freqs, power = welch(rr_even - rr_even.mean(), fs=4, nperseg=256)
    resp_rsa = band_peak(freqs, power, 0.15, 0.4)

    # ECG-derived respiration from the R-wave height
    r_height = ecg[peaks[1:]]
    h_even = np.interp(grid, t_beats, r_height)
    f2, p2 = welch(h_even - h_even.mean(), fs=4, nperseg=256)
    resp_edr = band_peak(f2, p2, 0.1, 0.5)

    # ---- shapes
    med = [median_beat(lead, peaks, fs) for lead in leads]
    template, beats = med[0]
    corr = np.array([np.corrcoef(b, template)[0, 1] for b in beats])
    pre = int(0.35 * fs)
    base = float(np.median(template[pre - int(0.08 * fs):pre - int(0.03 * fs)]))
    def amp(lo_ms, hi_ms, fn):
        seg = template[pre + int(lo_ms / 1000 * fs):pre + int(hi_ms / 1000 * fs)] - base
        return float(fn(seg))
    p_amp = amp(-250, -80, np.max)
    r_amp = float(template[pre] - base)
    s_amp = amp(0, 60, np.min)
    t_amp = amp(150, 420, lambda s: s[np.argmax(np.abs(s))])
    st_level = amp(int(qrs / 2) + 60, int(qrs / 2) + 80, np.mean)

    # 40 beats spread over the 5 minutes, both leads, at 125 Hz
    pick = np.linspace(0, len(beats) - 1, BEATS_KEPT).astype(int)
    step = int(round(fs / 125))
    def ds(x):
        return [round(float(v), 3) for v in x[::step]]
    beats2 = med[1][1]
    loop_beats = [[ds(beats[i] - base), ds(beats2[i] - np.median(beats2[i][:20]))] for i in pick if i < len(beats2)]

    # 12 s of lead II for the sound, normalised to ±1
    clip = ecg[: int(12 * fs)]
    clip = clip / np.max(np.abs(clip))

    return {
        "id": record,
        "sex": "female" if sex == "F" else "male",
        "age": None if age == "-1" else int(age),
        "leads": header.sig_name,
        "window": f"{start_s}–{start_s + WINDOW_S} s",
        "fs": fs,
        "beats": int(len(peaks)),
        "hr": round(60 / mean_rr, 1),
        "meanRR": round(mean_rr * 1000, 1),
        "sdnn": round(float(t_hrv["HRV_SDNN"].iloc[0]), 1),
        "rmssd": round(float(t_hrv["HRV_RMSSD"].iloc[0]), 1),
        "pnn50": round(float(t_hrv["HRV_pNN50"].iloc[0]), 1),
        "lf": round(float(f_hrv["HRV_LF"].iloc[0]), 1),         # ms² (NeuroKit2 already returns ms²)
        "hf": round(float(f_hrv["HRV_HF"].iloc[0]), 1),         # ms²
        "lfhf": round(float(f_hrv["HRV_LFHF"].iloc[0]), 2),
        "respRSA": round(resp_rsa * 60, 1),                     # breaths per minute
        "respEDR": round(resp_edr * 60, 1),
        "pr": pr, "qrs": qrs, "qt": qt, "qtConfidence": qt_conf, "marks": {k: round(v, 1) for k, v in marks["marks"].items()},
        "qtcB": round(qtc_bazett), "qtcF": round(qtc_fridericia),
        "pAmp": round(p_amp, 3), "rAmp": round(r_amp, 3), "sAmp": round(s_amp, 3),
        "tAmp": round(t_amp, 3), "st": round(st_level, 3),
        "shapeMean": round(float(np.mean(corr)), 4), "shapeSD": round(float(np.std(corr)), 4),
        "rr": [round(float(v) * 1000) for v in rr],
        "rHeight": [round(float(v), 3) for v in r_height],
        "loopFs": 125,
        "loopBeats": loop_beats,
        "median": [ds(med[0][0] - base), ds(med[1][0] - np.median(med[1][0][:20]))],
        "audio": [round(float(v), 4) for v in clip],
    }


if __name__ == "__main__":
    mitdb = Path(sys.argv[1])
    people = [analyse(mitdb, r, s) for r, s in PEOPLE]
    for p in people:
        print(f'{p["id"]} {p["sex"]:6} {p["age"]}  HR {p["hr"]}  RMSSD {p["rmssd"]}  LF/HF {p["lfhf"]}  '
              f'resp {p["respRSA"]}/{p["respEDR"]}  PR {p["pr"]} QRS {p["qrs"]} QT {p["qt"]} QTcB {p["qtcB"]}  '
              f'shape {p["shapeMean"]}', file=sys.stderr)
    out = Path(__file__).with_name("data.js")
    out.write_text(
        "/* data.js — generated by extract.py from the MIT-BIH Arrhythmia Database\n"
        " * (Moody & Mark 2001, via PhysioNet, ODC Attribution License). Do not edit by hand. */\n"
        "const PEOPLE = " + json.dumps(people, separators=(",", ":")) + ";\n"
    )
