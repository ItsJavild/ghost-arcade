import { describe, it, expect } from 'vitest';
import { defaultRig, layout, setOverlap, setCanvasWidth, parseRig, sourceRect, resetCalibration, overlapFromSeam } from './rig';
import { changeWarp, sampleWarp, usablePerspective } from './warp';
describe('three projector calibration', () => {
  it('keeps source coordinates continuous at both overlap seams', () => {
    const r = defaultRig(); setOverlap(r, 192);
    expect(layout(r.overlap)).toEqual({ width: 5376, height: 1080, starts: [0, 1728, 3456] });
    expect(r.outputs.map(o => [o.left, o.right])).toEqual([[0, .1], [.1, .1], [.1, 0]]);
  });
  it('round-trips independent meshes and placeholder assignments', () => {
    const r = defaultRig(); r.outputs[1].mesh[12].x = .6;
    expect(parseRig(JSON.stringify(r))).toEqual(r);
    expect(r.outputs[0].mesh[12].x).toBe(.5);
  });
  it('rejects corrupt and conflicting calibration files', () => {
    const r = defaultRig(); r.outputs[1].mesh[0].x = 3;
    expect(() => parseRig(JSON.stringify(r))).toThrow();
    const duplicate = defaultRig(); duplicate.outputs[0].displayId = duplicate.outputs[1].displayId = '123';
    expect(() => parseRig(JSON.stringify(duplicate))).toThrow();
  });
  it('resets only the requested calibration on the requested projector',()=>{
    const r=defaultRig();setOverlap(r,192);const o=r.outputs[1];o.displayId='monitor-2';o.mesh[12].x=.7;o.mask[0].x=.1;o.gamma=3;
    resetCalibration(r,1,'mesh');expect(o.mesh[12].x).toBe(.5);expect(o.mask[0].x).toBe(.1);expect(o.gamma).toBe(3);
    resetCalibration(r,1,'mask');expect(o.mask[0].x).toBe(0);expect(o.gamma).toBe(3);
    resetCalibration(r,1,'blend');expect(o.gamma).toBe(2.2);expect(o.left).toBe(.1);expect(o.displayId).toBe('monitor-2');
    expect(r.outputs[0].mesh[12].x).toBe(.5);
  });
  it('keeps manual blend widths while automatically updating linked seams',()=>{
    const r=defaultRig();r.outputs[1].autoBlend=false;r.outputs[1].left=.2;setOverlap(r,192);
    expect(r.outputs[1].left).toBe(.2);expect(r.outputs[0].right).toBe(.1);
    for(const seam of [1,2] as const){const l=layout(192);expect(overlapFromSeam(l.starts[seam]/l.width,seam)).toBe(192);}
  });
  it('supports different overlap amounts and recovers each seam drag position',()=>{
    const r=defaultRig();r.linkOverlaps=false;r.rightOverlap=0;setOverlap(r,120);setOverlap(r,240,2);
    const l=layout(r.overlap,r.rightOverlap);
    expect(l).toEqual({width:5400,height:1080,starts:[0,1800,3480]});
    expect(r.outputs.map(o=>[o.left,o.right])).toEqual([[0,.0625],[.0625,.125],[.125,0]]);
    for(const seam of [1,2] as const)expect(overlapFromSeam(l.starts[seam]/l.width,seam,r)).toBe(seam===1?120:240);
    expect(parseRig(JSON.stringify(r))).toEqual(r);
  });
  it('round-trips all warp modes and control points extending outside the raster',()=>{
    for(const type of ['perspective','linear','bezier'] as const){const r=defaultRig(),o=r.outputs[0];changeWarp(o,type);o.mesh[0].x=-.1;expect(parseRig(JSON.stringify(r))).toEqual(r);}
  });
  it('keeps blend-region sample positions attached to the destination warp',()=>{
    const o=defaultRig().outputs[0];changeWarp(o,'linear',9,5);const before=sampleWarp(o,.9,.5);o.mesh.forEach(p=>p.x-=.1);
    expect(sampleWarp(o,.9,.5).x).toBeCloseTo(before.x-.1);
    changeWarp(o,'bezier');expect(sampleWarp(o,.5,.5).x).toBeCloseTo(.4);
  });
  it('perspective pins land exactly at their four destinations',()=>{
    const o=defaultRig().outputs[0];changeWarp(o,'perspective');o.mesh=[{x:.1,y:.1},{x:.9,y:0},{x:0,y:1},{x:1,y:.8}];
    for(const [u,v,i] of [[0,0,0],[1,0,1],[0,1,2],[1,1,3]]){const p=sampleWarp(o,u,v);expect(p.x).toBeCloseTo(o.mesh[i].x);expect(p.y).toBeCloseTo(o.mesh[i].y);}
  });
  it('rejects collapsed and crossed perspective edits while allowing convex pinning',()=>{
    const o=defaultRig().outputs[0];changeWarp(o,'perspective');expect(usablePerspective(o)).toBe(true);
    o.mesh=[{x:.1,y:.1},{x:.9,y:0},{x:0,y:1},{x:1,y:.8}];expect(usablePerspective(o)).toBe(true);
    o.mesh[3]={x:0,y:0};expect(usablePerspective(o)).toBe(false);
    o.mesh[3]={...o.mesh[2]};expect(usablePerspective(o)).toBe(false);
  });
  it('sets a 4:1 canvas without changing projector calibration or routing',()=>{
    const r=defaultRig();r.outputs[0].displayId='left';r.outputs[1].mesh[12].x=.6;r.outputs[2].mask[0].x=.1;
    const before=structuredClone(r.outputs);setCanvasWidth(r,4320);
    expect(layout(r.overlap,r.rightOverlap)).toEqual({width:4320,height:1080,starts:[0,1200,2400]});
    expect(r.overlap).toBe(720);expect(r.rightOverlap).toBe(720);expect(r.linkOverlaps).toBe(true);
    expect(r.outputs.map(o=>[o.left,o.right])).toEqual([[0,.375],[.375,.375],[.375,0]]);
    r.outputs.forEach((o,i)=>{expect(o.mesh).toEqual(before[i].mesh);expect(o.mask).toEqual(before[i].mask);expect(o.displayId).toBe(before[i].displayId);});
    expect(parseRig(JSON.stringify(r))).toEqual(r);
  });
  it('sets exact odd widths, preserves manual fades and rejects impossible widths without changes',()=>{
    const r=defaultRig();r.outputs[1].autoBlend=false;r.outputs[1].left=.2;setCanvasWidth(r,4321);
    expect(layout(r.overlap,r.rightOverlap).width).toBe(4321);expect(r.linkOverlaps).toBe(false);expect(r.outputs[1].left).toBe(.2);
    const saved=JSON.stringify(r);for(const width of [0,4223,5761,4320.5,NaN]){expect(()=>setCanvasWidth(r,width)).toThrow();expect(JSON.stringify(r)).toBe(saved);}
  });
  it('fits a normal input inside a wide canvas without stretching', () => {
    expect(sourceRect(1920, 1080, 5760, 1080, 'contain')).toEqual({ x: 1920, y: 0, w: 1920, h: 1080 });
    expect(sourceRect(5760, 1080, 5760, 1080, 'contain')).toEqual({ x: 0, y: 0, w: 5760, h: 1080 });
  });
});
