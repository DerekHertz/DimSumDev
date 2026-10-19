import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { createBao } from './bao.mjs';
import { createDenScene } from './den-scene.mjs';
import { compactPanda, compactEnvironment } from './compact.mjs';
import { createLiveDenController } from './controller.mjs';
import { loadReview } from '../../review/review-data.mjs';
import { mountExpansionPond } from '../expansion/pond.mjs';
import { mountWorkZones, WORK_ZONE_IDS, OPEN_INTENTS } from '../expansion/work-zones.mjs';
import { createReviewAgents } from '../../review/agents.mjs';
import { liveActorsFromSnapshot } from '../../review/live-actors.mjs';
import { REVIEW_SKIES } from '../../review/site-plan.mjs';
import { agentFor, cardFor, pickedCard } from '../../overlay/proximity-card.mjs';

// The den: the v5 kit's village (den-mvp/25: teams, promenades, bamboo, the six leisure places) with the role pandas
// that walk it, mounted inside the app's canvas. The wrapping App owns the camera, the overlays and the board state.
// The frontier baskets and the tally ride on the same den through the controller. Live agents show only as
// the role pandas (agents.applyLive): the controller adds no ticket pandas and leaves residents alone.

// Sample pandas from the old lab carry props; the review scene wants them bare.
function clearSampleProps(panda) {
  const old = [];
  panda.model.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) old.push(o); });
  for (const object of old) { object.removeFromParent(); object.geometry.dispose(); }
  if (panda.materials.scarf) { panda.materials.scarf.dispose(); delete panda.materials.scarf; }
}

// Whatever the user chose while reviewing the den (visual direction) is the den's look.
function savedLook() {
  return { direction: loadReview()?.direction || 'traveler' };
}

export function RestaurantDen({ snapshot, placements, frontier, tally, selected, onSelect, onOpenTally, stage, onReady, onNearby, picked = null, onPick, zoneView = null, onZoneClick = null }) {
  const [den, setDen] = useState(null);
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [look] = useState(savedLook);
  const live = useRef(null);
  const inputs = useRef({}); inputs.current = { snapshot, placements, frontier, tally, selected, onSelect, onOpenTally, onNearby, picked, onPick, onZoneClick };
  const position = useRef(new THREE.Vector3()).current;
  const proximityElapsed = useRef(0);
  const { scene } = useThree();
  const sampleId = dark ? 'lantern' : 'morning';

  useEffect(() => {
    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setDark(theme.matches);
    theme.addEventListener('change', onChange);
    return () => theme.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const d = createDenScene(THREE, createBao);
    d.setLabels(true); d.setLanterns(sampleId === 'lantern');
    for (const p of d.pandas) clearSampleProps(p);
    for (const p of d.pandas) compactPanda(THREE, p);
    compactEnvironment(THREE, d);
    // den-mvp/17: the v5 koi pond, local only. Before the controller and actors, which copy den.obstacles.
    const pond = mountExpansionPond(d);
    // den-mvp/22: the repair bench and the archive. Marks come from the live state; a click opens a card or a thread.
    const work = mountWorkZones(d);
    const agents = createReviewAgents(d, createBao, { direction: look.direction });
    const controller = createLiveDenController(d, {
      ticketPandas: false,
      onCreate: (p) => compactPanda(THREE, p),
      onRemove: (ref) => stage.anchors.delete(ref),
    });
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const previous = { background: scene.background, fog: scene.fog };
    scene.background = new THREE.Color(REVIEW_SKIES[sampleId]);
    scene.fog = new THREE.Fog(REVIEW_SKIES[sampleId], 70, 115);
    live.current = { den: d, controller, media, pond, work, agents, anchored: new Set(), time: 0 };
    setDen(d); onReady(d);
    return () => {
      onReady(null); live.current = null;
      controller.dispose(); agents.dispose(); pond.dispose(); work.dispose(); d.dispose();
      scene.background = previous.background; scene.fog = previous.fog;
      stage.anchors.clear();
    };
  }, [scene, stage, onReady, sampleId, look]);

  useEffect(() => {
    const c = live.current?.controller;
    if (c) c.sync(placements, frontier, tally?.rods);
  }, [den, placements, frontier, tally]);

  // Real agents drive the role pandas (den-layout/03). The adapter is re-run each second so a tool-call
  // bubble fades after its TTL without waiting for a new snapshot.
  useEffect(() => {
    const agents = live.current?.agents;
    if (!agents) return undefined;
    const bind = () => agents.applyLive(liveActorsFromSnapshot(snapshot, { now: Date.now() }));
    bind();
    const timer = setInterval(bind, 1000);
    return () => clearInterval(timer);
  }, [den, snapshot]);

  useEffect(() => { live.current?.agents.setSelected(selected ?? null); }, [den, selected]);

  // The work zones show the den's own live state (viewFromBridge over the one snapshot App holds).
  useEffect(() => { if (zoneView) live.current?.work.apply(zoneView); }, [den, zoneView]);

  useFrame((_, delta) => {
    const l = live.current; if (!l) return;
    const reduced = l.media.matches, dt = Math.min(delta, 0.1);
    l.controller.update(dt, {
      reducedMotion: reduced, selected: inputs.current.selected,
    });
    if (!reduced) l.time += dt;
    l.pond.update(l.time, reduced); l.work.update(l.time, reduced); l.agents.update(reduced ? 0 : dt, reduced);
    l.den.world.updateMatrixWorld(true);
    // Chips and the card hang above the role pandas, the den's only live pandas; a ref that left drops its anchor.
    const figures = l.agents.liveFigures();
    for (const ref of l.anchored) if (!figures.has(ref)) { stage.anchors.delete(ref); l.anchored.delete(ref); }
    for (const [ref, { model }] of figures) {
      stage.anchors.set(ref, model.localToWorld(new THREE.Vector3(0, 4.45, 0)));
      l.anchored.add(ref);
    }
    for (const [ref, basket] of l.den.frontier) stage.anchors.set(ref, basket.localToWorld(new THREE.Vector3(0, 0.6, 0)));
    // Sample at 10 Hz, after the moving pandas' world matrices are updated. Idle and scenery pandas also get cards.
    proximityElapsed.current += dt;
    if (proximityElapsed.current >= 0.1) {
      proximityElapsed.current = 0;
      let card = null;
      // Walk mode: the panda in front of you. Overview: the panda the user clicked (the same card, whatever the distance).
      const walking = !!stage.explorer?.active, pick = walking ? null : inputs.current.picked;
      if (walking || pick != null) {
        const snap = inputs.current.snapshot;
        const boundRefs = new Set([...l.agents.actors.values()].map(a => a.live?.ref).filter(Boolean));
        const pandas = [...l.agents.actors].map(([id, a]) => {
          a.panda.model.getWorldPosition(position);
          // den-v1 loop S4: card content only. A panda the board has not bound reads the newest bridge agent of its role.
          const agent = agentFor({ role: a.role, ref: a.live?.ref }, snap?.agents, boundRefs);
          // Board-driven pandas precede bridge-owned runs: keep their honest state/tool, with no invented handle.
          const placement = a.live ? (snap?.placements ?? []).filter(row => row.ref === a.live.ref && (!row.role || row.role === a.role))
            .reduce((latest, row) => !latest || Date.parse(row.lastEventAt) > Date.parse(latest.lastEventAt) ? row : latest, null) : null;
          const tool = placement?.tool ?? null; // The card keeps the current tool after its floating bubble fades.
          return { id, name: a.name, role: a.role, dispatchable: !a.concept, team: a.team, position: { x: position.x, z: position.z }, ref: a.live?.ref, state: a.live?.state, tool, agent };
        });
        const camera = walking ? stage.explorer.camera : null;
        card = camera ? cardFor(pandas, snap?.approvals ?? [], { x: camera.position.x, z: camera.position.z, yaw: camera.rotation.y })
          : pickedCard(pandas, snap?.approvals ?? [], pick);
      }
      l.agents.hold(card?.id ?? null); // The panda the card is on stands still while you are with it.
      if (card) delete card.distance; // Distance selects the panda; it does not make the card re-render every stride.
      inputs.current.onNearby?.(card);
    }
  });

  const hit = (e) => {
    let object = e.object;
    while (object) {
      // Overview: a click on a role panda opens its card (the one walk mode shows). The ticket chip above it still opens the ticket.
      const actor = object.userData.actorKey;
      if (actor && !stage.explorer?.active && inputs.current.onPick) { e.stopPropagation(); inputs.current.onPick(actor); return; }
      // The pond's koi and tea table respond locally; nothing is sent to the bridge.
      const local = object.userData.denInteraction;
      // The repair bench and archive only open a card or a thread, through App; never Deliver, Run or Approve.
      if (local && WORK_ZONE_IDS.includes(local.zone)) {
        e.stopPropagation();
        if (OPEN_INTENTS.includes(local.intent)) inputs.current.onZoneClick?.(local.id); else live.current?.work.interact(local.id); // the lucky bao: a local response
        return;
      }
      if (local) { e.stopPropagation(); live.current?.pond.interact(local.id); return; }
      const ref = object.userData.ticketRef;
      if (ref) { e.stopPropagation(); inputs.current.onSelect(ref); return; }
      if (object.userData.tallyAbacus) { e.stopPropagation(); stage.tallyHit = true; inputs.current.onOpenTally(); return; }
      object = object.parent;
    }
  };
  const lantern = sampleId === 'lantern';
  return <>
    <hemisphereLight args={['#fff5db', '#627858', lantern ? 1.1 : 2.2]} />
    <directionalLight position={[-10, 18, 12]} intensity={lantern ? 1.4 : 3} color={lantern ? '#ffc886' : '#fff3d5'} castShadow
      shadow-mapSize={[1024, 1024]} shadow-camera-left={-30} shadow-camera-right={30}
      shadow-camera-top={30} shadow-camera-bottom={-30} shadow-normalBias={0.05} />
    <directionalLight position={[10, 8, -5]} intensity={1.1} color="#d6e9ff" />
    {den ? <primitive object={den.world} dispose={null} onClick={hit} /> : null}
  </>;
}
