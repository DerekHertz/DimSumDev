import * as THREE from 'three';
import {createModelLoader} from './assets.mjs';
import {mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import {previewTextures} from './assets.mjs';

// Clothing uses Bao-local coordinates: feet = 0, height = 3, front = +Z.
// Desk props use the live workstation anchor, including its position and turn.
export const WARDROBE_FITS = {
  'developer-vest': {role: 'Developer', label: 'Developer · utility vest', fit: 'torso', minY: 1.28, maxY: 2.20,
    lower: [0.95, 1.025, 0.01], upper: [0.69, 0.63, -0.025],
    relief: 0.10, clearance: 0.035, tint: '#597b80', colorOverride: '#485d8c'},
  'developer-headphones': {role: 'Developer', label: 'Developer · headphones', fit: 'box', size: [1.22, 0.88, 0.46],
    position: [0, 2.635, -0.065], rotation: [0, 0, 0], tint: '#b88950'},
  'qa-scarf': {role: 'QA', label: 'QA · tasting scarf', fit: 'collar',
    inner: [0.68, 0.56], outer: [0.91, 0.80], height: 0.38,
    position: [0, 2.07, 0.025], rotation: [0, 0, 0], tint: '#5c8d86'},
  'security-vest': {role: 'Security', label: 'Security · jade vest with frog closure',
    sourceAsset: 'developer-vest', fit: 'torso', minY: 1.28, maxY: 2.20,
    lower: [0.95, 1.025, 0.01], upper: [0.69, 0.63, -0.025],
    relief: 0.10, clearance: 0.035, tint: '#236f59', colorOverride: '#236f59',
    frogClosure: true, frogClosurePosition: [0, 1.87, 0.756]},
  'developer-boba': {role: 'Developer', label: 'Developer · desk boba', fit: 'uniform', height: 0.34,
    anchor: 'developerAccessories', grounded: true,
    position: [0.14, 0, -0.10], rotation: [0, 0, 0], tint: '#c29a70'},
  'developer-tablet': {role: 'Developer', label: 'Developer · landscape tablet', fit: 'uniform', width: 0.43,
    anchor: 'developerAccessories', grounded: true,
    position: [-0.08, 0, 0.22], rotation: [0, 0, 0], tint: '#43565f'},
};
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

function sourceMeshes(source, fit) {
  source.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(source);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const group = new THREE.Group();
  source.traverse(node => {
    if (!node.isMesh) return;
    const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
    const materials = (Array.isArray(node.material) ? node.material : [node.material]).map(material => {
      const copy = material.clone();
      // Draft GLBs have no authored materials. Preserve all refined textures.
      if (!copy.map && copy.color?.r > .95 && copy.color?.g > .95 && copy.color?.b > .95) copy.color.set(fit.tint);
      if (fit.colorOverride) {
        const jade = new THREE.Color(fit.colorOverride);
        copy.color.set('#ffffff');
        // Keep fabric luminance while giving the garment its planned cloth color.
        copy.onBeforeCompile = shader => {
          shader.uniforms.wardrobeTint = {value: jade};
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 wardrobeTint;')
            .replace('#include <map_fragment>', '#include <map_fragment>\nfloat wardrobeLuma = dot(diffuseColor.rgb, vec3(.2126,.7152,.0722));\ndiffuseColor.rgb = wardrobeTint * mix(.65, 1.25, wardrobeLuma);');
        };
        copy.customProgramCacheKey = () => 'wardrobe-cloth-v2';
      }
      copy.metalness = Math.min(copy.metalness || 0, .15);
      copy.roughness = Math.max(copy.roughness || .8, .65);
      copy.side = THREE.DoubleSide;
      return copy;
    });
    const mesh = new THREE.Mesh(geometry, Array.isArray(node.material) ? materials : materials[0]);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = node.name;
    group.add(mesh);
  });
  return {group, bounds, center, size};
}

function addFrogClosure(group, fit) {
  const closure = new THREE.Group();
  closure.name = 'Security · local frog closure';
  closure.position.fromArray(fit.frogClosurePosition);
  const material = new THREE.MeshStandardMaterial({color: '#d8ba79', roughness: .8});
  for (const side of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * .18, 0, -.014), new THREE.Vector3(side * .09, .035, 0),
      new THREE.Vector3(side * .025, .018, .008), new THREE.Vector3(side * .09, -.022, 0),
      new THREE.Vector3(side * .18, 0, -.014),
    ]);
    closure.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 20, .012, 6, false), material));
  }
  const knot = new THREE.Mesh(new THREE.SphereGeometry(.026, 10, 8), material);
  knot.scale.set(1.25, .8, .7); closure.add(knot); group.add(closure);
}

/** Fit a disposable copy; the loaded GLB and saved source bytes remain intact. */
export function fitRoleAsset(source, id, override = {}) {
  const fit = {...WARDROBE_FITS[id], ...override};
  if (!fit.fit) throw new Error(`No wardrobe fit for ${id}`);
  // Resize browser uploads only; full downloaded GLBs stay unchanged.
  previewTextures(source, 1024);
  const {group, center, size} = sourceMeshes(source, fit);
  const point = new THREE.Vector3();

  group.traverse(node => {
    if (!node.isMesh) return;
    // No tessellation before the wrap (2026-10-19): it multiplied each garment's triangles for every panda wearing it.
    const position = node.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).sub(center);
      const nx = point.x / (size.x / 2), ny = point.y / size.y + .5, nz = point.z / (size.z / 2);
      if (fit.fit === 'torso') {
        // The saved draft is a narrow, flat human vest. Map its tube around
        // Bao's rounded chest, and crop its height above the large white belly.
        const t = clamp(ny, 0, 1);
        const rx = lerp(fit.lower[0], fit.upper[0], t);
        const rz = lerp(fit.lower[1], fit.upper[1], t);
        const cz = lerp(fit.lower[2], fit.upper[2], t);
        const angle = Math.atan2(nx, nz);
        const y = lerp(fit.minY, fit.maxY, ny);
        const details = Math.max(0, Math.hypot(nx, nz) - .83) * fit.relief;
        const radius = 1 + details;
        point.set(Math.sin(angle) * rx * radius, y, Math.cos(angle) * rz * radius + cz);
      } else if (fit.fit === 'collar') {
        // Open the cowl's small neck hole without enlarging its outer bulk.
        const angle = Math.atan2(nx, nz);
        const t = clamp((Math.hypot(nx, nz) - .36) / .89, 0, 1);
        point.set(Math.sin(angle) * lerp(fit.inner[0], fit.outer[0], t),
          (ny - .5) * fit.height,
          Math.cos(angle) * lerp(fit.inner[1], fit.outer[1], t));
      } else if (fit.fit === 'uniform') {
        point.multiplyScalar(fit.width ? fit.width / size.x : fit.height / size.y);
      } else {
        point.set(nx * fit.size[0] / 2, (ny - .5) * fit.size[1], nz * fit.size[2] / 2);
      }
      position.setXYZ(i, point.x, point.y, point.z);
    }
    position.needsUpdate = true;
    if (fit.fit === 'torso' || fit.fit === 'collar') {
      // Tessellation emits split triangles; weld before recomputing smooth normals.
      node.geometry.deleteAttribute('normal');
      const original = node.geometry;
      node.geometry = mergeVertices(original, .00001);
      original.dispose();
    }
    node.geometry.computeVertexNormals();
    node.geometry.computeBoundingBox();
    node.geometry.computeBoundingSphere();
  });
  if (fit.fit !== 'torso') {
    group.position.fromArray(fit.position);
    group.rotation.fromArray(fit.rotation || [0, 0, 0]);
    if (fit.grounded) {
      group.updateMatrixWorld(true);
      group.position.y += fit.position[1] - new THREE.Box3().setFromObject(group).min.y;
    }
  }
  if (fit.frogClosure) addFrogClosure(group, fit);
  group.name = `Wardrobe · ${id}`;
  group.userData = {wardrobeId: id, role: fit.role, label: fit.label || `${fit.role} · ${id.replace(fit.role.toLowerCase() + '-', '')}`, previewOnly: false,
    sourceDimensions: size.toArray(), fit};
  return group;
}

function dispose(group) {
  group.traverse(node => {
    node.geometry?.dispose();
    for (const material of node.material ? Array.isArray(node.material) ? node.material : [node.material] : []) material.dispose();
  });
}

/** Missing assets remain individual status entries; they never block the outfit. */
export async function loadRoleWardrobe(den, {
  only = Object.keys(WARDROBE_FITS), baseUrl = '/wardrobe/', fits = {},
  urls = {}, onProgress = () => {},
} = {}) {
  const loader = createModelLoader();
  const report = {loaded: [], missing: [], failed: [], previewOnly: false};
  await Promise.all(only.map(async id => {
    const spec = {...WARDROBE_FITS[id], ...fits[id]};
    const person = den.residents.children.find(child => child.name === spec.role);
    if (!person) { report.missing.push({id, reason: `Resident ${spec.role} unavailable`}); return; }
    const anchors = den.roleWorkspaces?.anchors;
    const parent = spec.anchor ? anchors?.[spec.anchor] : person;
    if (!parent) { report.missing.push({id, reason: `Workspace anchor ${spec.anchor} unavailable`}); return; }
    try {
      const url = urls[id] || `${baseUrl}${id}.glb`;
      const gltf = await loader.loadAsync(url);
      const garment = fitRoleAsset(gltf.scene, id, fits[id]);
      const previous = parent.getObjectByName(garment.name);
      if (previous) {parent.remove(previous); dispose(previous);}
      parent.add(garment);
      garment.updateMatrixWorld(true);
      report.loaded.push({id, role: spec.role, label: garment.userData.label, parent: parent.name, url, fit: garment.userData.fit});
      onProgress({id, status: 'loaded'});
    } catch (error) {
      report.failed.push({id, reason: error.message});
      onProgress({id, status: 'unavailable', reason: error.message});
    }
  }));
  den.renderer.shadowMap.needsUpdate = true;
  den.wardrobe = report;
  return report;
}
