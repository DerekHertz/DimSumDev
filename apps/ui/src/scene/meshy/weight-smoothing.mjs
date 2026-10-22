// team-and-den-ux/25-35: Meshy's prop-holding sources fuse paws and props to the belly. Position-only
// weights cut sharply across that contact, so a raised arm tears the surface between neighbours a few
// centimetres apart. Diffusing weights over the welded mesh spreads the change across many rings.

/**
 * Laplacian diffusion of skin weights over the mesh's edges.
 * `weights[i]` is the [[bone, weight], …] list for vertex i; equal positions (UV seams) share one value.
 * Vertices for which `pin(position)` is true keep their weights and anchor the diffusion.
 * Returns new lists of at most four normalised influences.
 */
export function smoothWeights(positions, index, weights, { iterations = 0, alpha = .5, pin = () => false } = {}) {
  if (!iterations) return weights;
  const count = positions.count, key = new Map(), weld = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const k = [positions.getX(i), positions.getY(i), positions.getZ(i)].map(v => Math.round(v * 1e5)).join(',');
    if (!key.has(k)) key.set(k, key.size);
    weld[i] = key.get(k);
  }
  const n = key.size, bones = [...new Set(weights.flatMap(w => w.map(([b]) => b)))], slot = new Map(bones.map((b, i) => [b, i])), B = bones.length;
  let value = new Float32Array(n * B);
  const pinned = new Uint8Array(n), seen = new Uint8Array(n), p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < count; i++) {
    const w = weld[i]; if (seen[w]) continue; seen[w] = 1;
    for (const [bone, weight] of weights[i]) value[w * B + slot.get(bone)] = weight;
    p.x = positions.getX(i); p.y = positions.getY(i); p.z = positions.getZ(i);
    if (pin(p)) pinned[w] = 1;
  }
  const neighbours = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < index.count; i += 3) {
    const t = [weld[index.getX(i)], weld[index.getX(i + 1)], weld[index.getX(i + 2)]];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) if (t[a] !== t[b]) { neighbours[t[a]].add(t[b]); neighbours[t[b]].add(t[a]); }
  }
  const lists = neighbours.map(s => Int32Array.from(s));
  let next = new Float32Array(n * B);
  for (let step = 0; step < iterations; step++) {
    for (let v = 0; v < n; v++) {
      const list = lists[v];
      if (pinned[v] || !list.length) { for (let b = 0; b < B; b++) next[v * B + b] = value[v * B + b]; continue; }
      for (let b = 0; b < B; b++) {
        let sum = 0; for (const u of list) sum += value[u * B + b];
        next[v * B + b] = (1 - alpha) * value[v * B + b] + alpha * sum / list.length;
      }
    }
    [value, next] = [next, value];
  }
  return Array.from({ length: count }, (_, i) => {
    const w = weld[i], top = [];
    for (let b = 0; b < B; b++) if (value[w * B + b] > 1e-4) top.push([bones[b], value[w * B + b]]);
    top.sort((x, y) => y[1] - x[1]).splice(4);
    const total = top.reduce((s, [, x]) => s + x, 0);
    return top.map(([bone, x]) => [bone, x / total]);
  });
}
