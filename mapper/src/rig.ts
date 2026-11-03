export type Point = { x: number; y: number };
export type Projector = {
  id: string; name: string; displayId: string; mesh: Point[];
  mask: Point[]; left: number; right: number; gamma: number;
  brightness: number; black: number;
  warpType?: 'linear' | 'perspective' | 'bezier'; meshCols?: number; meshRows?: number;
  autoBlend?: boolean; blendGamma?: number;
};
export type Rig = { version: 1; overlap: number; rightOverlap?:number; linkOverlaps?:boolean; fit: 'contain' | 'cover' | 'stretch'; source: string; outputs: Projector[] };
export const GRID = 5;
export function identityMesh(): Point[] {
  return Array.from({ length: GRID * GRID }, (_, i) => ({ x: (i % GRID) / (GRID - 1), y: Math.floor(i / GRID) / (GRID - 1) }));
}
export function defaultRig(): Rig {
  return { version: 1, overlap: 0, fit: 'contain', source: '', outputs: ['Left', 'Center', 'Right'].map((name, i) => ({ id: `projector-${i}`, name, displayId: '', mesh: identityMesh(), mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], left: 0, right: 0, gamma: 2.2, brightness: 1, black: 0 })) };
}
export function layout(overlap: number, rightOverlap=overlap) {
  return { width: 5760-overlap-rightOverlap, height: 1080, starts: [0,1920-overlap,3840-overlap-rightOverlap] };
}
export function automaticEdges(rig:Rig,index:number){
  const right=rig.rightOverlap??rig.overlap;
  return {left:index===0?0:(index===1?rig.overlap:right)/1920,right:index===2?0:(index===0?rig.overlap:right)/1920};
}
export function setOverlap(rig: Rig, overlap: number, seam:1|2=1) {
  const n=Math.max(0,Math.min(768,Math.round(overlap)));
  if(rig.linkOverlaps!==false){rig.overlap=n;rig.rightOverlap=n;}
  else if(seam===1)rig.overlap=n;else rig.rightOverlap=n;
  rig.outputs.forEach((o,i)=>{if(o.autoBlend!==false)Object.assign(o,automaticEdges(rig,i));});
}
export type ResetPart = 'mesh' | 'mask' | 'blend' | 'all';
export function resetCalibration(rig: Rig, index: number, part: ResetPart) {
  const o = rig.outputs[index];
  if(part==='all'){o.warpType='linear';o.meshCols=5;o.meshRows=5;}
  if (part === 'mesh' || part === 'all') {
    const cols=o.meshCols??5, rows=o.meshRows??5;
    o.mesh=Array.from({length:cols*rows},(_,i)=>({x:(i%cols)/(cols-1),y:Math.floor(i/cols)/(rows-1)}));
  }
  if (part === 'mask' || part === 'all') o.mask = defaultRig().outputs[index].mask;
  if (part === 'blend' || part === 'all') {
    Object.assign(o,automaticEdges(rig,index));
    o.gamma = 2.2; o.brightness = 1; o.black = 0; o.autoBlend = true; o.blendGamma = 1;
  }
}
export function overlapFromSeam(fraction: number, seam: 1 | 2, rig?:Rig) {
  if(rig?.linkOverlaps===false){
    const n=seam===1?(1920-5760*fraction+fraction*(rig.rightOverlap??rig.overlap))/(1-fraction):5760-1920/(1-fraction)-rig.overlap;
    return Math.max(0,Math.min(768,Math.round(n)));
  }
  const denominator = seam - 2 * fraction;
  if (Math.abs(denominator) < 1e-6) return 0;
  return Math.max(0, Math.min(768, Math.round((1920 * seam - 5760 * fraction) / denominator)));
}
export function sourceRect(sw: number, sh: number, dw: number, dh: number, fit: Rig['fit']) {
  const scale = fit === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const w = fit === 'stretch' ? dw : sw * scale, h = fit === 'stretch' ? dh : sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
function points(value: unknown, count: number, min = 0, max = 1): value is Point[] {
  return Array.isArray(value) && value.length === count && value.every(p => p && finite(p.x, min, max) && finite(p.y, min, max));
}
export function parseRig(text: string): Rig {
  const r = JSON.parse(text);
  if (r?.version !== 1 || !finite(r.overlap, 0, 768) || (r.rightOverlap!==undefined&&!finite(r.rightOverlap,0,768)) || (r.linkOverlaps!==undefined&&typeof r.linkOverlaps!=='boolean') || !['contain', 'cover', 'stretch'].includes(r.fit) || typeof r.source !== 'string' || !Array.isArray(r.outputs) || r.outputs.length !== 3) throw Error('Invalid mapper rig file.');
  const used = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const o = r.outputs[i];
    const cols=o?.meshCols??5, rows=o?.meshRows??5;
    if (![2,3,4,5,9,17,33].includes(cols) || ![2,3,4,5,9,17,33].includes(rows) || (o?.warpType!==undefined && !['linear','perspective','bezier'].includes(o.warpType)) || (o?.warpType==='perspective' && (cols!==2 || rows!==2)) || (o?.warpType==='bezier' && (cols!==4 || rows!==4))) throw Error('Invalid warp geometry.');
    if (!o || o.id !== `projector-${i}` || typeof o.name !== 'string' || o.name.length > 80 || typeof o.displayId !== 'string' || !points(o.mesh, cols*rows, -1, 2) || !points(o.mask, 4) || !finite(o.left, 0, .5) || !finite(o.right, 0, .5) || !finite(o.gamma, 1, 4) || !finite(o.brightness, 0, 2) || !finite(o.black, 0, .2) || (o.blendGamma!==undefined && !finite(o.blendGamma,.2,4)) || (o.autoBlend!==undefined && typeof o.autoBlend!=='boolean')) throw Error('Invalid projector calibration.');
    if (o.displayId && used.has(o.displayId)) throw Error('Each projector needs a different display.');
    if (o.displayId) used.add(o.displayId);
  }
  return r;
}
