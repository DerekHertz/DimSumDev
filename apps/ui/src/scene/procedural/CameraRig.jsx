import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { cameraConfig, clampTarget, clampZoom } from './camera.mjs';
import { bindCameraControls } from './camera-controls.mjs';
import { createDenExplorer } from './explorer.mjs';
import * as THREE from 'three';
import { walkLocation } from '../meshy/layout.mjs';

export function CameraRig({store,stage,den,onModeChange,onHint,onCursorChange,onLocationChange}) {
  const { gl, size, set } = useThree();
  const initialCamera=useThree(s=>s.camera);
  const camera=useRef(initialCamera).current;
  const navigation=useRef({enabled:true}).current;
  const location=useRef(null);
  useEffect(()=>{
    if(!den)return;
    const explorer=createDenExplorer(THREE,{
      canvas:gl.domElement,orbitControls:navigation,den,onHint,onCursorChange,
      onModeChange:active=>{
        set({camera:active?explorer.camera:camera});
        stage.camera=active?explorer.camera:camera;onModeChange(active);
        gl.domElement.closest('main')?.focus({preventScroll:true});
      },
    });
    explorer.resize(gl.domElement.clientWidth/Math.max(1,gl.domElement.clientHeight));
    stage.explorer=explorer;
    document.querySelectorAll('[data-den-walk]').forEach(el=>explorer.bindButton(el,el.dataset.denWalk));
    return ()=>{explorer.dispose();stage.explorer=null;set({camera});};
  },[den,gl,camera,set,stage,navigation,onModeChange,onHint,onCursorChange]);
  // The viewport follows the canvas (the whole scene box: the cards float over it); kept in a ref for the handlers.
  const viewport = useRef({ width: size.width, height: size.height });
  viewport.current = { width: size.width, height: size.height };
  const now = useRef({ target: [...store.getTarget()], zoom: store.getZoom() });

  useEffect(() => {
    const canvas = gl.domElement;
    return bindCameraControls({
      canvas, host:canvas.parentElement?.closest('main')??canvas, store,
      enabled:()=>navigation.enabled,
      view:()=>({...viewport.current,zoom:store.getZoom(),orbit:store.getOrbit()}),
    });
  }, [gl, store, navigation]);

  useFrame((_, dt) => {
    if(stage.explorer?.active){
      stage.explorer.resize(size.width/Math.max(1,size.height));
      stage.explorer.update(Math.min(dt,0.1));
      const next = walkLocation(stage.explorer.camera.position);
      if (next !== location.current) { location.current = next; onLocationChange?.(next); }
      stage.camera=stage.explorer.camera;stage.size=size;stage.camera.userData.viewport=size;
      return;
    }
    location.current = null;
    const n = now.current;
    // A zoom-out or a resize can shrink the pan limits under the goal: pull it back in.
    store.setTarget(clampTarget(store.getTarget()));
    const goal = { target: store.getTarget(), zoom: store.getZoom() };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      n.target = [...goal.target];
      n.zoom = goal.zoom;
    } else {
      const k = 1 - Math.exp(-10 * dt);
      n.target = n.target.map((v, i) => v + (goal.target[i] - v) * k);
      n.zoom += (goal.zoom - n.zoom) * k;
    }
    const zoom = clampZoom(n.zoom);
    const { width, height } = viewport.current;
    const c = cameraConfig({ width, height, zoom, target: n.target, orbit:store.getOrbit() });
    camera.userData.viewport = { width, height }; // the size this frustum was built for; ChipLayer projects with it
    camera.manual = true; // R3F would otherwise reset the frustum to pixel units on resize
    camera.zoom = 1;
    camera.near = c.near;
    camera.far = c.far;
    camera.left = c.left;
    camera.right = c.right;
    camera.top = c.top;
    camera.bottom = c.bottom;
    camera.position.set(...c.position);
    camera.up.set(...c.up);
    camera.lookAt(...c.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    stage.camera=camera;stage.size=size;
  });
  return null;
}
