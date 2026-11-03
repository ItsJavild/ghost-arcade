import { describe, it, expect } from 'vitest';
import { defaultRig, layout, setOverlap, parseRig, sourceRect } from './rig';
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
    const r = defaultRig(); r.outputs[1].mesh[0].x = 2;
    expect(() => parseRig(JSON.stringify(r))).toThrow();
    const duplicate = defaultRig(); duplicate.outputs[0].displayId = duplicate.outputs[1].displayId = '123';
    expect(() => parseRig(JSON.stringify(duplicate))).toThrow();
  });
  it('fits a normal input inside a wide canvas without stretching', () => {
    expect(sourceRect(1920, 1080, 5760, 1080, 'contain')).toEqual({ x: 1920, y: 0, w: 1920, h: 1080 });
    expect(sourceRect(5760, 1080, 5760, 1080, 'contain')).toEqual({ x: 0, y: 0, w: 5760, h: 1080 });
  });
});
