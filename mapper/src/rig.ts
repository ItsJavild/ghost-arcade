export type Point = { x: number; y: number };
export type Projector = {
  id: string; name: string; displayId: string; mesh: Point[];
  mask: Point[]; left: number; right: number; gamma: number;
  brightness: number; black: number;
};
export type Rig = { version: 1; overlap: number; fit: 'contain' | 'cover' | 'stretch'; source: string; outputs: Projector[] };
export const GRID = 5;
export function identityMesh(): Point[] {
  return Array.from({ length: GRID * GRID }, (_, i) => ({ x: (i % GRID) / (GRID - 1), y: Math.floor(i / GRID) / (GRID - 1) }));
}
export function defaultRig(): Rig {
  return { version: 1, overlap: 0, fit: 'contain', source: '', outputs: ['Left', 'Center', 'Right'].map((name, i) => ({ id: `projector-${i}`, name, displayId: '', mesh: identityMesh(), mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], left: 0, right: 0, gamma: 2.2, brightness: 1, black: 0 })) };
}
export function layout(overlap: number) {
  const step = 1920 - overlap;
  return { width: 5760 - overlap * 2, height: 1080, starts: [0, step, step * 2] };
}
export function setOverlap(rig: Rig, overlap: number) {
  rig.overlap = Math.max(0, Math.min(768, Math.round(overlap)));
  rig.outputs.forEach((o, i) => { o.left = i > 0 ? rig.overlap / 1920 : 0; o.right = i < 2 ? rig.overlap / 1920 : 0; });
}
export function sourceRect(sw: number, sh: number, dw: number, dh: number, fit: Rig['fit']) {
  const scale = fit === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const w = fit === 'stretch' ? dw : sw * scale, h = fit === 'stretch' ? dh : sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
function points(value: unknown, count: number): value is Point[] {
  return Array.isArray(value) && value.length === count && value.every(p => p && finite(p.x, 0, 1) && finite(p.y, 0, 1));
}
export function parseRig(text: string): Rig {
  const r = JSON.parse(text);
  if (r?.version !== 1 || !finite(r.overlap, 0, 768) || !['contain', 'cover', 'stretch'].includes(r.fit) || typeof r.source !== 'string' || !Array.isArray(r.outputs) || r.outputs.length !== 3) throw Error('Invalid mapper rig file.');
  const used = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const o = r.outputs[i];
    if (!o || o.id !== `projector-${i}` || typeof o.name !== 'string' || o.name.length > 80 || typeof o.displayId !== 'string' || !points(o.mesh, 25) || !points(o.mask, 4) || !finite(o.left, 0, .5) || !finite(o.right, 0, .5) || !finite(o.gamma, 1, 4) || !finite(o.brightness, 0, 2) || !finite(o.black, 0, .2)) throw Error('Invalid projector calibration.');
    if (o.displayId && used.has(o.displayId)) throw Error('Each projector needs a different display.');
    if (o.displayId) used.add(o.displayId);
  }
  return r;
}
