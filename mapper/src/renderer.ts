// One GPU context and one source upload shared by all three projectors.
import * as THREE from 'three';
import { layout, sourceRect, type Projector, type Rig } from './rig';
import { dimensions, sampleWarp } from './warp';
export type CalibrationPattern = 'none' | 'grid' | 'white' | 'gray' | 'black' | 'bars';
const patternCodes:Record<CalibrationPattern,number>={none:0,grid:1,white:2,gray:3,black:4,bars:5};
type Backend = { renderer: THREE.WebGLRenderer; texture: THREE.Texture; dataMode: boolean; material: THREE.ShaderMaterial; width: number; height: number; revision: number; users: number };
const backends = new WeakMap<HTMLCanvasElement, Backend>();
function textureFor(source: HTMLCanvasElement) {
  const texture = new THREE.CanvasTexture(source);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false; return texture;
}
function backendFor(source: HTMLCanvasElement): Backend {
  const existing = backends.get(source); if (existing) { existing.users++; return existing; }
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setSize(1920, 1080, false); renderer.setClearColor(0x000000, 1);
  renderer.debug.onShaderError = () => { throw Error('Projector shader failed to compile.'); };
  const texture = textureFor(source);
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    uniforms: { diagnostic: { value: 0 }, stageWidth:{value:5760}, content: { value: new THREE.Vector4(0,0,1,1) }, sourceFlip: { value: 1 }, picture: { value: texture }, crop: { value: new THREE.Vector2() }, edges: { value: new THREE.Vector2() }, correction: { value: new THREE.Vector3() }, blendPower: { value: 1 }, masks: { value: Array.from({ length: 4 }, () => new THREE.Vector2()) } },
      vertexShader: `attribute float warpW; varying vec2 local;
        void main(){local=uv; gl_Position=vec4(position.xy*warpW,0.,warpW);}`,
      fragmentShader: `precision highp float;
        uniform float diagnostic; uniform float stageWidth; uniform sampler2D picture; uniform vec4 content; uniform float sourceFlip; uniform vec2 crop; uniform vec2 edges;
        uniform vec3 correction; uniform float blendPower; uniform vec2 masks[4]; varying vec2 local;
        void main(){vec2 target=vec2(gl_FragCoord.x/1920.,1.-gl_FragCoord.y/1080.);
          bool inside=false;
          for(int i=0;i<4;i++){vec2 a=masks[i]; vec2 b=masks[(i+1)-((i+1)/4)*4];
            if((a.y>target.y)!=(b.y>target.y)){
              if(target.x<(b.x-a.x)*(target.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
            }
          }
          if(!inside){gl_FragColor=vec4(0.,0.,0.,1.);return;}
          vec2 stage=vec2(crop.x+local.x*crop.y,local.y);
          vec3 color;
          if(diagnostic>0.5){
            color=vec3(1.);
            if(diagnostic<1.5){
              vec2 pixel=stage*vec2(stageWidth,1080.);
              vec2 cell=mod(pixel,vec2(120.));
              float line=1.-step(2.,min(min(cell.x,120.-cell.x),min(cell.y,120.-cell.y)));
              color=mix(vec3(.015),vec3(1.),line);
              if(abs(pixel.y-540.)<2.)color=vec3(1.,0.,0.);
            }else if(diagnostic<2.5)color=vec3(1.);
            else if(diagnostic<3.5)color=vec3(pow(.5,2.2));
            else if(diagnostic<4.5)color=vec3(0.);
            else {float bar=floor(stage.x*8.);color=bar<1.?vec3(1.):bar<2.?vec3(1.,1.,0.):bar<3.?vec3(0.,1.,1.):bar<4.?vec3(0.,1.,0.):bar<5.?vec3(1.,0.,1.):bar<6.?vec3(1.,0.,0.):bar<7.?vec3(0.,0.,1.):vec3(0.);}
          }else{
            vec2 p=(stage-content.xy)/content.zw;
            if(any(lessThan(p,vec2(0.)))||any(greaterThan(p,vec2(1.)))){gl_FragColor=vec4(0.,0.,0.,1.);return;}
            if(sourceFlip>0.5)p.y=1.-p.y;
            vec4 sampleColor=texture2D(picture,p);
            color=pow(max(sampleColor.rgb,vec3(0.)),vec3(2.2))*sampleColor.a;
          }
          float weight=1.;
          if(edges.x>0.)weight*=smoothstep(0.,edges.x,local.x);
          if(edges.y>0.)weight*=smoothstep(0.,edges.y,1.-local.x);
          weight=pow(weight,blendPower);
          color=color*correction.x*weight+vec3((diagnostic>3.5&&diagnostic<4.5?0.:correction.z)*weight);
          gl_FragColor=vec4(pow(clamp(color,0.,1.),vec3(1./correction.y)),1.);
        }`
  });
  const backend:Backend = { renderer, texture, material, dataMode: false, width: source.width, height: source.height, revision: -1, users: 1 };
  backends.set(source, backend); return backend;
}
export class ProjectorRenderer {
  private backend: Backend;
  private geometry = new THREE.BufferGeometry();
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private context: CanvasRenderingContext2D;
  private meshKey = '';
  constructor(readonly canvas: HTMLCanvasElement, private source: HTMLCanvasElement) {
    canvas.width = 1920; canvas.height = 1080;
    this.context = canvas.getContext('2d', { alpha: false })!;
    this.backend = backendFor(source);
    const mesh = new THREE.Mesh(this.geometry, this.backend.material); mesh.frustumCulled = false; this.scene.add(mesh);
  }
  setInputFrame(data:Uint8Array, width:number, height:number) {
    const b=this.backend;
    if(!b.dataMode||b.width!==width||b.height!==height){
      b.texture.dispose();const texture=new THREE.DataTexture(data,width,height,THREE.RGBAFormat);
      texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;
      b.texture=texture;b.material.uniforms.picture.value=texture;b.width=width;b.height=height;b.dataMode=true;
    }else{(b.texture as THREE.DataTexture).image.data=data;}
    b.texture.needsUpdate=true;
  }
  useCanvas(){
    const b=this.backend;if(!b.dataMode)return;
    b.texture.dispose();b.texture=textureFor(this.source);b.width=this.source.width;b.height=this.source.height;b.material.uniforms.picture.value=b.texture;b.dataMode=false;b.revision=-1;
  }
  render(output: Projector, index: number, rig: Rig, blackout: boolean, revision: number, diagnostic:CalibrationPattern='none') {
    const b = this.backend;
    if (!b.dataMode && (this.source.width !== b.width || this.source.height !== b.height)) {
      b.texture.dispose(); b.texture = textureFor(this.source);
      b.material.uniforms.picture.value = b.texture;
      b.width = this.source.width; b.height = this.source.height; b.revision = -1;
    }
    if (!b.dataMode && b.revision !== revision) { b.texture.needsUpdate = true; b.revision = revision; }
    const key = JSON.stringify([output.warpType, output.meshCols, output.meshRows, output.mesh]);
    if (key !== this.meshKey) {
      const dim=dimensions(output);
      const cols=output.warpType==='perspective'?2:output.warpType==='bezier'?33:Math.max(9,dim.cols);
      const rows=output.warpType==='perspective'?2:output.warpType==='bezier'?33:Math.max(9,dim.rows);
      const pos=new Float32Array(cols*rows*3), uv=new Float32Array(cols*rows*2), weights=new Float32Array(cols*rows), indices:number[]=[];
      for(let y=0;y<rows;y++) for(let x=0;x<cols;x++) {
        const i=y*cols+x, u=x/(cols-1), v=y/(rows-1), p=sampleWarp(output,u,v);
        pos[i*3]=p.x*2-1;pos[i*3+1]=1-p.y*2;uv[i*2]=u;uv[i*2+1]=v;weights[i]=p.w;
        if(x<cols-1&&y<rows-1)indices.push(i,i+cols,i+1,i+1,i+cols,i+cols+1);
      }
      this.geometry.setIndex(indices);
      this.geometry.setAttribute('position',new THREE.BufferAttribute(pos,3));
      this.geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));
      this.geometry.setAttribute('warpW',new THREE.BufferAttribute(weights,1));
      this.meshKey = key;
    }
    const l = layout(rig.overlap,rig.rightOverlap??rig.overlap), u = b.material.uniforms;
    u.diagnostic.value=patternCodes[diagnostic];u.stageWidth.value=l.width;
    u.crop.value.set(l.starts[index] / l.width, 1920 / l.width);
    const bounds=b.dataMode?sourceRect(b.width,b.height,l.width,1080,rig.fit):{x:0,y:0,w:l.width,h:1080};
    u.content.value.set(bounds.x/l.width,bounds.y/1080,bounds.w/l.width,bounds.h/1080);
    u.sourceFlip.value=b.dataMode?0:1;
    u.edges.value.set(output.left, output.right);
    u.blendPower.value=output.blendGamma??1;
    u.correction.value.set(output.brightness, output.gamma, output.black);
    output.mask.forEach((p, i) => u.masks.value[i].set(p.x, p.y));
    b.renderer.clear(); if (!blackout) b.renderer.render(this.scene, this.camera);
    // Immediate accelerated canvas copy; no CPU pixel readback or three source uploads.
    this.context.drawImage(b.renderer.domElement, 0, 0);
  }
  dispose() {
    this.geometry.dispose(); const b = this.backend;
    if (--b.users === 0) { b.texture.dispose(); b.material.dispose(); b.renderer.dispose(); backends.delete(this.source); }
  }
}
