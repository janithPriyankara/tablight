// The fitting half of train-head.mjs, apart from data loading and embedding so it can be tested on small vectors:
// the val split, the L2 choice, the 5-fold Unsorted threshold, the override similarity and the final head.
//
// fitHead({ X, Y, rule, labels, calIdx }): X = unit vectors, Y = label indices, rule = ruleGroup per row (or null),
// calIdx = calibration pool indices (CALIBRATION) or null. With calIdx, only those rows pick the L2, the threshold
// and the similarity (each `count` in the result says how many rows a choice was scored on); without it, a seeded
// stratified 15% split and 5-fold out-of-fold scores over the whole pool, exactly as before calibration existed.

/**
 * Neighbour blend (chosen by 5-fold CV, see docs §12): final scores = (1-ALPHA)·p_head + ALPHA·vote of the
 * K nearest pool items, each weighted exp(SHARP·cosine). Shipped as int8 vectors in head.json.
 */
export const KNN = { k: 10, alpha: 0.3, sharp: 10 };
export const FOLDS = 5;

export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fitHead({
  X, Y, rule, labels, calIdx,
  seed = 42,
  valShare = 0.15,
  epochs = 600,
  lr = 0.05,
  l2Grid = [1e-4, 3e-4, 1e-3, 3e-3],
  /** Max share of `other` items the threshold may let through to a real group (val split). */
  maxOtherAssigned = 0.3,
  /**
   * A tab filed in the wrong group costs the user more than one left in Unsorted (they must notice it, then move
   * it). The Unsorted threshold maximises right - wrongCost * wrong on the val split, so weak guesses stay Unsorted.
   */
  wrongCost = 2,
  /** Required precision of the learned-exemplar override (val split). */
  overridePrecision = 0.95,
  log = console.log,
}) {
  const LABELS = labels;
  const OTHER = LABELS.indexOf('other');
  const DIM = X[0].length;
  const n = X.length;
  const all = () => Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed);
  function shuffle(xs) {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  }

  // Stratified split (with calibration: calibration rows are the validation split, the rest the training split).
  const valIdx = [];
  const trainIdx = [];
  if (calIdx) {
    if (!calIdx.length) throw new Error('no calibration row is in the pool');
    const inCal = new Set(calIdx);
    valIdx.push(...calIdx);
    trainIdx.push(...all().filter((i) => !inCal.has(i)));
  } else for (let c = 0; c < LABELS.length; c++) {
    const idx = shuffle(Y.map((y, i) => (y === c ? i : -1)).filter((i) => i >= 0));
    const nVal = Math.round(idx.length * valShare);
    valIdx.push(...idx.slice(0, nVal));
    trainIdx.push(...idx.slice(nVal));
  }

  // ---------- logistic regression (full-batch Adam, L2, class-balanced) ----------
  function softmax(z) {
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / s);
  }
  function logits(W, b, x) {
    return W.map((row, c) => {
      let s = b[c];
      for (let d = 0; d < DIM; d++) s += row[d] * x[d];
      return s;
    });
  }
  function train(idx, l2) {
    const C = LABELS.length;
    const counts = new Array(C).fill(0);
    for (const i of idx) counts[Y[i]]++;
    const cw = counts.map((k) => (k ? idx.length / (C * k) : 0));
    const wsum = idx.reduce((s, i) => s + cw[Y[i]], 0);
    const W = Array.from({ length: C }, () => new Float64Array(DIM));
    const b = new Float64Array(C);
    const mW = W.map(() => new Float64Array(DIM));
    const vW = W.map(() => new Float64Array(DIM));
    const mb = new Float64Array(C);
    const vb = new Float64Array(C);
    const [b1, b2, eps] = [0.9, 0.999, 1e-8];
    for (let t = 1; t <= epochs; t++) {
      const gW = W.map(() => new Float64Array(DIM));
      const gb = new Float64Array(C);
      for (const i of idx) {
        const p = softmax(logits(W, b, X[i]));
        const w = cw[Y[i]] / wsum;
        for (let c = 0; c < C; c++) {
          const g = w * (p[c] - (c === Y[i] ? 1 : 0));
          if (g === 0) continue;
          gb[c] += g;
          const row = gW[c];
          const x = X[i];
          for (let d = 0; d < DIM; d++) row[d] += g * x[d];
        }
      }
      for (let c = 0; c < C; c++) {
        for (let d = 0; d < DIM; d++) {
          const g = gW[c][d] + l2 * W[c][d];
          mW[c][d] = b1 * mW[c][d] + (1 - b1) * g;
          vW[c][d] = b2 * vW[c][d] + (1 - b2) * g * g;
          W[c][d] -= (lr * (mW[c][d] / (1 - b1 ** t))) / (Math.sqrt(vW[c][d] / (1 - b2 ** t)) + eps);
        }
        mb[c] = b1 * mb[c] + (1 - b1) * gb[c];
        vb[c] = b2 * vb[c] + (1 - b2) * gb[c] * gb[c];
        b[c] -= (lr * (mb[c] / (1 - b1 ** t))) / (Math.sqrt(vb[c] / (1 - b2 ** t)) + eps);
      }
    }
    return { W: W.map((r) => Array.from(r)), b: Array.from(b) };
  }

  /** Neighbour vote over `ref` pool items (indices), as the shipped classify() does with head.knn. */
  function knnVote(i, ref) {
    const sims = [];
    for (const j of ref) {
      let s = 0;
      for (let d = 0; d < DIM; d++) s += X[i][d] * X[j][d];
      sims.push([s, Y[j]]);
    }
    sims.sort((a, b) => b[0] - a[0]);
    const v = new Array(LABELS.length).fill(0);
    let S = 0;
    for (const [s, y] of sims.slice(0, KNN.k)) {
      const w = Math.exp(KNN.sharp * s);
      v[y] += w;
      S += w;
    }
    return v.map((x) => x / S);
  }
  /** Pipeline on one item: rule first, then head blended with neighbours (other / low confidence → Unsorted). */
  function predict(head, i, threshold) {
    if (rule[i]) return rule[i];
    head.cache ??= new Map(); // blended scores per item: the threshold search re-reads them ~90 times
    let p = head.cache.get(i);
    if (!p) {
      const ph = softmax(logits(head.W, head.b, X[i]));
      const vote = knnVote(i, head.ref);
      p = ph.map((x, c) => (1 - KNN.alpha) * x + KNN.alpha * vote[c]);
      head.cache.set(i, p);
    }
    let top = 0;
    for (let c = 1; c < p.length; c++) if (p[c] > p[top]) top = c;
    return top === OTHER || p[top] < threshold ? null : LABELS[top];
  }
  function evaluate(head, idx, threshold) {
    let ok = 0;
    let k = 0;
    let others = 0;
    let otherAssigned = 0;
    let wrong = 0;
    for (const i of idx) {
      const g = predict(head, i, threshold);
      if (Y[i] === OTHER) {
        others++;
        if (g !== null) otherAssigned++;
      } else {
        k++;
        if (g === LABELS[Y[i]]) ok++;
        else if (g !== null) wrong++;
      }
    }
    const acc = ok / k;
    const wrongRate = (wrong + otherAssigned) / (k + others);
    return {
      acc, wrongRate, utility: (ok - wrongCost * (wrong + otherAssigned)) / (k + others),
      otherRate: others ? otherAssigned / others : 0, count: k + others,
    };
  }
  function bestThreshold(head, idx) {
    let best = null;
    for (let t = 0; t <= 0.9 + 1e-9; t += 0.01) {
      const r = evaluate(head, idx, t);
      if (r.otherRate > maxOtherAssigned) continue;
      if (!best || r.utility > best.utility) best = { threshold: Math.round(t * 100) / 100, ...r };
    }
    return best ?? { threshold: 0.9, ...evaluate(head, idx, 0.9) };
  }

  // ---------- model selection on the val split ----------
  let chosen = null;
  for (const l2 of l2Grid) {
    const head = { ...train(trainIdx, l2), ref: trainIdx };
    const r = bestThreshold(head, valIdx);
    log(
      `l2=${l2}: val acc ${(r.acc * 100).toFixed(1)}% @ t=${r.threshold}, wrong ${(r.wrongRate * 100).toFixed(1)}%, ` +
        `other assigned ${(r.otherRate * 100).toFixed(0)}%`,
    );
    // Ties go to the larger L2 (simpler model).
    if (!chosen || r.utility >= chosen.utility) chosen = { l2, head, ...r };
  }

  // Unsorted threshold for the chosen L2, from 5-fold out-of-fold scores over the scored rows: the whole pool, or
  // with calibration only the calibration rows. A single 15% val split is too small for it: the threshold it picks
  // swings by 0.1+ when a few items change.
  const foldOf = new Array(n);
  // With calibration only calibration rows are folded and scored; each fold's head trains on every other pool row.
  const scored = calIdx ?? all();
  for (let c = 0; c < LABELS.length; c++) {
    shuffle(scored.filter((i) => Y[i] === c)).forEach((i, k) => (foldOf[i] = k % FOLDS));
  }
  const oof = { cache: new Map() };
  for (let f = 0; f < FOLDS; f++) {
    const rest = all().filter((i) => foldOf[i] !== f);
    const h = { ...train(rest, chosen.l2), ref: rest };
    for (const i of scored) if (foldOf[i] === f) predict(h, i, 0);
    for (const [i, p] of h.cache ?? []) oof.cache.set(i, p);
  }
  const cv = bestThreshold(oof, scored);
  log(
    `${FOLDS}-fold: acc ${(cv.acc * 100).toFixed(1)}% @ t=${cv.threshold}, wrong ${(cv.wrongRate * 100).toFixed(1)}%, ` +
      `other assigned ${(cv.otherRate * 100).toFixed(0)}% (at t=0: wrong ${(evaluate(oof, scored, 0).wrongRate * 100).toFixed(1)}%)`,
  );

  // Learned-exemplar override: treat train-split items as a user's learned exemplars and pick the
  // lowest cosine at which "nearest exemplar's group" is right ≥ overridePrecision of the time on val.
  const dot = (a, b) => a.reduce((s, x, d) => s + x * b[d], 0);
  const nearest = valIdx.map((i) => {
    let best = -1;
    let g = -1;
    for (const j of trainIdx) {
      if (Y[j] === OTHER) continue;
      const s = dot(X[i], X[j]);
      if (s > best) [best, g] = [s, Y[j]];
    }
    return { sim: best, right: g === Y[i] };
  });
  let similarity = 0.95;
  for (let s = 0.5; s <= 0.95 + 1e-9; s += 0.01) {
    const hits = nearest.filter((x) => x.sim >= s);
    if (hits.length >= 10 && hits.filter((x) => x.right).length / hits.length >= overridePrecision) {
      similarity = Math.round(s * 100) / 100;
      break;
    }
  }

  // Final head: same L2, trained on the whole pool (every row, calibration rows included).
  const final = train(all(), chosen.l2);
  return { chosen, cv, similarity, similarityCount: nearest.length, final, valIdx, trainIdx, scored };
}
