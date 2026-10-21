import * as T from "three";
// Decode shipped geometry without browser image APIs; native scene captures verify
// the atlas itself. Preserve node transforms just as GLTFLoader does in the app.
export function readGlbGeometry(bytes) {
  const length = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + length)), bin = bytes.subarray(28 + length);
  const attribute = index => {
    const a = doc.accessors[index], v = doc.bufferViews[a.bufferView];
    const Type = {5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array}[a.componentType], width = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
    const start = (v.byteOffset || 0) + (a.byteOffset || 0), data = bin.subarray(start,start+a.count*width*Type.BYTES_PER_ELEMENT);
    return new T.BufferAttribute(new Type(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)),width);
  };
  const nodes = doc.nodes.map(n => {
    const object = new T.Group();
    if(n.matrix) object.applyMatrix4(new T.Matrix4().fromArray(n.matrix));
    else {if(n.translation)object.position.fromArray(n.translation);if(n.rotation)object.quaternion.fromArray(n.rotation);if(n.scale)object.scale.fromArray(n.scale);}
    if(n.mesh!==undefined)for(const p of doc.meshes[n.mesh].primitives){
      const g = new T.BufferGeometry();
      for(const [semantic,name]of [['POSITION','position'],['NORMAL','normal'],['TEXCOORD_0','uv'],['COLOR_0','color']])if(p.attributes[semantic]!==undefined)g.setAttribute(name,attribute(p.attributes[semantic]));
      if(p.indices!==undefined)g.setIndex(attribute(p.indices));
      object.add(new T.Mesh(g,new T.MeshStandardMaterial({map:doc.images?.length?new T.Texture():null,vertexColors:Boolean(g.attributes.color)})));
    }
    return object;
  });
  doc.nodes.forEach((n,i)=>n.children?.forEach(c=>nodes[i].add(nodes[c])));
  const scene = new T.Group();for(const i of doc.scenes[doc.scene||0].nodes)scene.add(nodes[i]);return scene;
}

