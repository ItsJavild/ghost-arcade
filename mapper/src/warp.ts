import type { Point, Projector } from './rig';
export type WarpType = 'linear' | 'perspective' | 'bezier';
export function dimensions(o: Projector) { return { cols: o.meshCols ?? 5, rows: o.meshRows ?? 5 }; }
export function grid(cols: number, rows: number): Point[] {
  return Array.from({ length: cols * rows }, (_, i) => ({ x: (i % cols) / (cols - 1), y: Math.floor(i / cols) / (rows - 1) }));
}
export function sampleWarp(o: Projector, u: number, v: number): Point & { w: number } {
  const { cols, rows } = dimensions(o);
  if (o.warpType === 'bezier') {
    const b = (t: number) => [(1-t)**3, 3*t*(1-t)**2, 3*t*t*(1-t), t**3];
    const bu = b(u), bv = b(v); let x = 0, y = 0;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const p = o.mesh[j*4+i], weight=bu[i]*bv[j]; x+=p.x*weight; y+=p.y*weight; }
    return { x, y, w: 1 };
  }
  if (o.warpType === 'perspective') {
    const [a,b,c,d] = o.mesh;
    const dx1=b.x-d.x, dx2=c.x-d.x, dx3=a.x-b.x-c.x+d.x;
    const dy1=b.y-d.y, dy2=c.y-d.y, dy3=a.y-b.y-c.y+d.y;
    const det=dx1*dy2-dx2*dy1;
    const g=Math.abs(det)<1e-9?0:(dx3*dy2-dx2*dy3)/det;
    const h=Math.abs(det)<1e-9?0:(dx1*dy3-dx3*dy1)/det;
    const w=1+g*u+h*v;
    return { x: ((b.x-a.x+g*b.x)*u+(c.x-a.x+h*c.x)*v+a.x)/w, y: ((b.y-a.y+g*b.y)*u+(c.y-a.y+h*c.y)*v+a.y)/w, w };
  }
  const sx=u*(cols-1), sy=v*(rows-1), ix=Math.min(cols-2,Math.floor(sx)), iy=Math.min(rows-2,Math.floor(sy)), tx=sx-ix, ty=sy-iy;
  const a=o.mesh[iy*cols+ix], b=o.mesh[iy*cols+ix+1], c=o.mesh[(iy+1)*cols+ix], d=o.mesh[(iy+1)*cols+ix+1];
  return { x:a.x*(1-tx)*(1-ty)+b.x*tx*(1-ty)+c.x*(1-tx)*ty+d.x*tx*ty, y:a.y*(1-tx)*(1-ty)+b.y*tx*(1-ty)+c.y*(1-tx)*ty+d.y*tx*ty, w:1 };
}
export function changeWarp(o: Projector, type: WarpType, cols?: number, rows?: number) {
  const old = structuredClone(o);
  const n = type === 'perspective' ? 2 : type === 'bezier' ? 4 : (cols ?? 5);
  const m = type === 'perspective' ? 2 : type === 'bezier' ? 4 : (rows ?? n);
  o.mesh = grid(n,m).map(p => { const q=sampleWarp(old,p.x,p.y); return {x:q.x,y:q.y}; });
  o.meshCols=n; o.meshRows=m; o.warpType=type;
}
export function blendBoundary(o: Projector, u: number) {
  return Array.from({length:33},(_,i)=>sampleWarp(o,u,i/32));
}
