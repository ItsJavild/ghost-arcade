// Reduced projector pipeline, adapted from Ghost Arcade's Three.js geometry
// and GPU output blend approach. Geometry lives in projector coordinates;
// UVs independently select a region of the shared input canvas.
import * as THREE from 'three';
import { GRID, layout, type Projector, type Rig } from './rig';
export class ProjectorRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private texture: THREE.CanvasTexture;
  private sourceWidth: number;
  private sourceHeight: number;
  constructor(readonly canvas: HTMLCanvasElement, source: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setSize(1920, 1080, false);
    this.renderer.setClearColor(0x000000, 1);
    this.texture = new THREE.CanvasTexture(source);
    this.sourceWidth = source.width; this.sourceHeight = source.height;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    const indices: number[] = [];
    for (let y = 0; y < GRID - 1; y++) for (let x = 0; x < GRID - 1; x++) {
      const a = y * GRID + x; indices.push(a, a + GRID, a + 1, a + 1, a + GRID, a + GRID + 1);
    }
    this.geometry.setIndex(indices);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GRID * GRID * 3), 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(GRID * GRID * 2), 2));
    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      uniforms: { picture: { value: this.texture }, crop: { value: new THREE.Vector2() }, edges: { value: new THREE.Vector2() }, correction: { value: new THREE.Vector3() }, masks: { value: Array.from({ length: 4 }, () => new THREE.Vector2()) } },
      vertexShader: `varying vec2 local; varying vec2 target;
        void main(){local=uv; target=vec2(position.x*.5+.5,.5-position.y*.5); gl_Position=vec4(position,1.);}`,
      fragmentShader: `precision highp float;
        uniform sampler2D picture; uniform vec2 crop; uniform vec2 edges;
        uniform vec3 correction; uniform vec2 masks[4]; varying vec2 local; varying vec2 target;
        void main(){
          bool inside=false;
          for(int i=0;i<4;i++){vec2 a=masks[i]; vec2 b=masks[(i+1)-((i+1)/4)*4];
            if((a.y>target.y)!=(b.y>target.y)){
              if(target.x<(b.x-a.x)*(target.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
            }
          }
          if(!inside){gl_FragColor=vec4(0.,0.,0.,1.);return;}
          vec2 p=vec2(crop.x+local.x*crop.y,1.-local.y);
          vec4 sampleColor=texture2D(picture,p);
          vec3 color=pow(max(sampleColor.rgb,vec3(0.)),vec3(2.2))*sampleColor.a;
          float weight=1.;
          if(edges.x>0.)weight*=smoothstep(0.,edges.x,local.x);
          if(edges.y>0.)weight*=smoothstep(0.,edges.y,1.-local.x);
          color=color*correction.x*weight+vec3(correction.z*weight);
          gl_FragColor=vec4(pow(clamp(color,0.,1.),vec3(1./correction.y)),1.);
        }`
    });
    const mesh = new THREE.Mesh(this.geometry, this.material); mesh.frustumCulled = false; this.scene.add(mesh);
  }
  render(output: Projector, index: number, rig: Rig, blackout: boolean) {
    const source = this.texture.image as HTMLCanvasElement;
    if (source.width !== this.sourceWidth || source.height !== this.sourceHeight) {
      this.texture.dispose(); this.texture = new THREE.CanvasTexture(source);
      this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
      this.texture.generateMipmaps = false;
      this.sourceWidth = source.width; this.sourceHeight = source.height;
      this.material.uniforms.picture.value = this.texture;
    }
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const uv = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    output.mesh.forEach((p, i) => { pos.setXYZ(i, p.x * 2 - 1, 1 - p.y * 2, 0); uv.setXY(i, (i % GRID) / (GRID - 1), Math.floor(i / GRID) / (GRID - 1)); });
    pos.needsUpdate = uv.needsUpdate = true;
    const l = layout(rig.overlap), u = this.material.uniforms;
    u.crop.value.set(l.starts[index] / l.width, 1920 / l.width);
    u.edges.value.set(output.left, output.right);
    u.correction.value.set(output.brightness, output.gamma, output.black);
    output.mask.forEach((p, i) => u.masks.value[i].set(p.x, p.y));
    this.texture.needsUpdate = true;
    this.renderer.clear();
    if (!blackout) this.renderer.render(this.scene, this.camera);
  }
  dispose() { this.texture.dispose(); this.geometry.dispose(); this.material.dispose(); this.renderer.dispose(); }
}
