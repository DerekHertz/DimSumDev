import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Canvas, events as defaultEvents } from "@react-three/fiber";
import { CameraRig } from "./scene/procedural/CameraRig.jsx";
import { MeshyDen } from "./scene/meshy/MeshyDen.jsx";
import { FrameCap } from "./scene/frame-cap.mjs";
import { PandaCard } from "./scene/procedural/PandaCard.jsx";
import { ProximityCard } from "./overlay/ProximityCard.jsx";
import { TranscriptPanel, useTranscript } from "./overlay/TranscriptPanel.jsx";
import { ApprovalPanel, useApprovalReview } from "./overlay/ApprovalPanel.jsx";
import { MessageComposer, useMessageComposer } from "./overlay/MessageComposer.jsx";
import { createBridgeClient } from "./state/bridge-client.mjs";
import { approvalDemoParams, createApprovalDemo } from "./scene/approval-fixture.mjs";
import { createDenCameraStore } from "./scene/procedural/camera.mjs";
import { TALLY_ANCHOR } from "./scene/procedural/bindings.mjs";
import { denEvents } from "./scene/procedural/events.mjs";
import "./scene/procedural/den.css";
import { ChipLayer } from "./scene/ChipLayer.jsx";
import { MAX_PLUSH, sceneFromState, withPassPlacement } from "./scene/scene-from-state.mjs";
import { useLiveState } from "./live.js";
import { demoRequested, useDemoSnapshot, useHandoffs } from "./handoff-state.js";
import { useMetrics } from "./metrics-state.js";
import { dashboardModel } from "./panel/dashboard-model.mjs";
import { tallyRods } from "./scene/tally-face.mjs";
import { TallyBody } from "./scene/TallyCard.jsx";
import { useNow } from "./panel/Panel.jsx";
import { answerCardFor, needsYouModel } from "./overlay/overlay-model.mjs";
import { panelPlaceholder } from "./state/connection.mjs";
import { createCameraStore } from "./scene/camera-store.mjs";
import { LogoPill, Cards } from "./overlay/Cards.jsx";
import { useSession } from "./session/useSession.js";
import { ZoomSwitcher } from "./overlay/Bottom.jsx";
import { DemoAnnouncer, DemoStrip, useDemoMode } from "./demo/DemoControls.jsx";
import { demoCard } from "./demo/demo-card.mjs";
import { viewFromBridge } from "./scene/expansion/integration/bridge-adapter.mjs";
import { routeWorkClick, unavailableReason } from "./scene/expansion/work-zones.mjs";
import { useArchiveLibrary } from "./scene/expansion/archive-library.js";
import { liveActorsFromSnapshot } from "./review/live-actors.mjs";
import { ToolBubbleLayer } from './scene/ToolBubbleLayer.jsx';
import { agentFor, pickedCard } from "./overlay/proximity-card.mjs";
import { DESK_THREAD } from "./overlay/transcript-panel.mjs";
import { Residents } from "./shell/Residents.jsx";
import { Rail } from "./shell/Rail.jsx";
import { Sheet } from "./shell/Sheet.jsx";
import { AuditReplay } from "./audit/AuditReplay.jsx";
import { replayParam } from "./audit/runs/index.mjs";
import { SHEET_HEADS, buildLabel, escapeAction, railBadges } from "./shell/rail-model.mjs";
import { deskActivity } from "./shell/desk-model.mjs";
import { actorBindings, NAVIGATION_TARGETS, MESHY_TEAM_LABELS } from "./scene/meshy/layout.mjs";
import { MeetingLayer } from "./scene/MeetingLayer.jsx";
import { claimOf, tableMeeting } from "./scene/meshy/meeting-table.mjs";
import { RESIDENTS, RUNTIME_UNAVAILABLE, boundAgentKey } from './shell/resident-inventory.mjs';
import {createRoofPreference} from './scene/meshy/roof-preference.mjs';
import {activeResidents} from './scene/meshy/approved-plan.mjs';
const SCENE_RESIDENTS=activeResidents(RESIDENTS);

class SceneBoundary extends Component {
  state={error:null};
  static getDerivedStateFromError(error){return {error};}
  render(){return this.state.error?<p className="den-error" role="alert">The 3D den could not load. Your board controls are still available. Reload to try again.</p>:this.props.children;}
}

const noSubscribe = () => () => {};
const noSnapshot = () => null;
const SCENE = 'main[aria-label="Den scene"]';
const focusEl = (el) => { if (el?.isConnected) { el.focus({ preventScroll: true }); return true; } return false; };

function activeCount(snapshot) {
  const active = new Set(["claimed", "in-review", "blocked", "ready-for-human"]);
  const refs = new Set(snapshot.tickets.filter((t) => active.has(t.status)).map((t) => t.ref));
  for (const r of snapshot.frontier ?? []) refs.add(r);
  return refs.size;
}

// team-and-den-ux/04 (design/04-spec.md): the den fills the window. A thin bar on top, the icon rail on the left, and the
// live scene in the rest. Sheets dock over the scene: one topic by the rail, one conversation or meeting on the right.
// Opening or closing a sheet never moves the camera, changes the level, leaves walk mode or deselects a panda.
export function App() {
  const live = useLiveState();
  const steering = useSession();
  const [demo] = useState(demoRequested);
  const demoSnapshot = useDemoSnapshot(demo);
  // den-v1/09: Demo mode replays recorded events into the den (demo/). It reads no session and makes no request.
  const onDemoChange = useRef(() => {});
  const [denDemo, denDemoMode] = useDemoMode((active) => onDemoChange.current(active));
  const { connection, metricsRevision } = live;
  // Dev-only approval demo (den-v1/06, scene/approval-fixture.mjs): one pending approval answered by a stub bridge. Never in a production build.
  const [approvalDemo] = useState(() => {
    const params = approvalDemoParams(location.search, import.meta.env.DEV);
    return params ? createApprovalDemo(params) : null;
  });
  const approvalDemoSnapshot = useSyncExternalStore(approvalDemo?.subscribe ?? noSubscribe, approvalDemo?.getSnapshot ?? noSnapshot);
  useEffect(() => {
    if (!approvalDemo || approvalDemoSnapshot.approvals.some((a) => a.status === "pending")) return undefined;
    const timer = setTimeout(() => approvalDemo.rearm(), 6000);
    return () => clearTimeout(timer);
  }, [approvalDemo, approvalDemoSnapshot]);
  const snapshot = denDemo.snapshot ?? demoSnapshot ?? approvalDemoSnapshot ?? live.snapshot;
  const inDemo = demo || denDemo.active;
  const placeholder = inDemo || approvalDemo ? null : panelPlaceholder(connection);
  const [selected, setSelected] = useState(null);
  const stage = useMemo(() => ({ anchors: new Map(), camera: null, size: null, explorer: null, tallyAnchor: TALLY_ANCHOR }), []);
  const camera = useMemo(() => createDenCameraStore(createCameraStore({minZoom:.55,levels:{1:1,2:.75,3:.55}}),()=>stage.explorer?.exit(), NAVIGATION_TARGETS), [stage]);
  const [den,setDen]=useState(null);
  const [roofs]=useState(()=>{let storage;try{storage=window.localStorage;}catch{}return createRoofPreference(storage);});
  const [roofMode,setRoofMode]=useState(roofs.mode);
  useEffect(()=>{den?.garden?.setRoofMode(roofMode);},[den,roofMode]);
  const [gardenLoad, setGardenLoad] = useState({ status: 'loading', message: 'Opening the garden…' });
  const [exploring,setExploring]=useState(false);
  const [cursorFree, setCursorFree] = useState(false);
  const [walkPlace, setWalkPlace] = useState('Entrance');
  const [nearby, setNearby] = useState(null);
  const [scenePresentations,setScenePresentations]=useState([]);
  const onScenePresentations=useCallback(rows=>setScenePresentations(previous=>JSON.stringify(previous)===JSON.stringify(rows)?previous:rows),[]);
  // Overview (live den run, 2026-10-10): a clicked panda shows the card walk mode shows. `engaged` is walk mode or a
  // picked panda: the permission review and the message box stay open, and their keys act, in either.
  const [picked, setPicked] = useState(null);
  const engaged = exploring || picked != null;
  const now = useNow();
  const previousBindings = useRef(new Map());
  const bindings = useMemo(() => actorBindings(liveActorsFromSnapshot(snapshot, { toolActivity: inDemo ? {} : live.toolActivity, connection }), previousBindings.current, {meeting: tableMeeting(snapshot?.meetings, now)}), [snapshot, live.toolActivity, inDemo, connection, now]);
  useEffect(() => { previousBindings.current = bindings; }, [bindings]);
  const requests = useMemo(() => needsYouModel(snapshot, now).requests, [snapshot, now]);
  const onNearby = useCallback(card => setNearby(previous => JSON.stringify(previous) === JSON.stringify(card) ? previous : card), []);
  const releaseCursor = useCallback(() => stage.explorer?.freeCursor?.(), [stage]);

  // The two sheet slots (spec 1.3). Each remembers when it opened (Escape closes the last one first) and what opened it
  // (focus goes back there when it closes).
  // Hierarchy audit replay: ?replay=<id> opens that run's replay sheet over the scene.
  const [replayId] = useState(() => (typeof location === "undefined" ? null : replayParam(location.search)));
  const [topic, setTopic] = useState(() => (replayId ? "replay" : null));
  const [meetingId, setMeetingId] = useState(null);
  const [meetingRole, setMeetingRole] = useState(null);
  const [left, setLeft] = useState(() => new Set());
  const opened = useRef({ topic: 0, side: 0 });
  const opener = useRef({ topic: null, side: null });
  const stamp = (slot, from) => {
    opened.current[slot] = performance.now();
    opener.current[slot] = from ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
  };
  // Focus back to what opened a sheet; if it is gone, the rail entry for the topic, then the selected panda's card, then the scene.
  const focusBack = useCallback((slot, entry) => {
    if (focusEl(opener.current[slot])) return true;
    if (entry && focusEl(document.querySelector(`[data-rail="${entry}"]`))) return true;
    if (focusEl(document.querySelector(".proximity-card button"))) return true;
    return focusEl(document.querySelector(SCENE));
  }, []);

  const reviewOpen = useRef(false);
  const approvalOpen = useRef(false);
  const messageClose = useRef(null);
  // In Demo mode the card is routed through demoCard: T, E and Q greyed, R on only when a transcript line was recorded.
  const shownCard = useMemo(() => (denDemo.active ? demoCard(nearby, { transcripts: denDemo.transcripts }) : nearby), [nearby, denDemo.active, denDemo.transcripts]);
  const sideOwned = useRef(false);
  const transcript = useTranscript({ card: shownCard, exploring: engaged, onOpen: () => {
    setMeetingId(null);
    if (!sideOwned.current) stamp('side');
    releaseCursor();
  }, blocked: reviewOpen, returnFocus: () => focusBack('side') });
  const transcriptClose = useRef(null);
  transcriptClose.current = transcript.close;
  const openConversation = useCallback((agentId, who, from, options) => {
    if (!agentId) return;
    releaseCursor();
    stamp('side', from);
    sideOwned.current = true;
    setMeetingId(null);
    transcript.openFor(agentId, who, options);
    sideOwned.current = false;
  }, [transcript.openFor, releaseCursor]);
  const inspectTools = useCallback(row => {
    const tools=row?.toolActivity;
    if(!tools?.sources?.length||reviewOpen.current)return;
    const source=tools.sources[0];
    openConversation(source.runId,{...row,project:source.project,runtime:source.runtime,role:source.role},undefined,{source,sources:tools.sources,expandTool:true});
  },[openConversation]);
  const bridge = useMemo(() => approvalDemo?.client ?? createBridgeClient({ fetch: steering.session.fetch }), [steering.session, approvalDemo]);
  const onReviewOpen = useCallback(() => { messageClose.current?.(); releaseCursor(); }, [releaseCursor]);
  // E and Q answer the panda card in view, or else the first waiting permission request (overlay-model.mjs answerCardFor).
  const answerCard = useMemo(() => answerCardFor(nearby, requests), [nearby, requests]);
  const approval = useApprovalReview({ client: bridge, card: answerCard, exploring: engaged, cursorFree, demo: inDemo, snapshot, onOpen: onReviewOpen });
  // den-mvp/37: an agent's question is answered in its thread, where its options are; a tool ask opens the review.
  const asksQuestion = (card) => (snapshot?.approvals ?? []).some((a) => a.agentId === card.agentId && a.state === "pending" && Array.isArray(a.questions));
  const answerRequest = useCallback((card) => {
    if (!card) return;
    if (asksQuestion(card)) openConversation(card.agentId, { name: card.name, role: card.role, state: card.state });
    else approval.review.open(card, { mode: "card", demo: inDemo });
  }, [approval.review, inDemo, snapshot, openConversation]);
  const answerAgent = useCallback((agentId) => answerRequest(requests.find((r) => r.card?.agentId === agentId)?.card), [answerRequest, requests]);
  // organism-infra/230: "Open thread" on a Needs you card opens that agent's conversation, in or out of walk mode.
  const openThread = useCallback((card) => { if (card?.agentId) openConversation(card.agentId, { name: card.name, role: card.role, state: card.state }); }, [openConversation]);
  // den-v1/07: T opens the message composer. A message the agent took shows on its transcript entry (den-v1 loop S5), which reaches the composer with each snapshot and frame.
  const message = useMessageComposer({ client: bridge, card: nearby, exploring: engaged, cursorFree, demo: inDemo, snapshot, transcripts: live.transcripts, onOpen: releaseCursor, blocked: approvalOpen });
  messageClose.current = message.composer.close;
  useEffect(() => approvalDemo?.onEvent((event) => message.composer.observe(event)), [approvalDemo, message.composer]); // dev-only demo acks (scene/approval-fixture.mjs)
  approvalOpen.current = approval.state.open;
  reviewOpen.current = approval.state.open || message.state.open; // the transcript keys stand down while either panel is open

  // The topic sheet: a rail entry opens it, the open entry closes it, another entry swaps it in place.
  const openTopic = useCallback((id, from) => {
    releaseCursor();
    setTopic((current) => {
      if (current === id) { queueMicrotask(() => focusBack('topic', id)); return null; }
      stamp('topic', from);
      return id;
    });
  }, [focusBack, releaseCursor]);
  const closeTopic = useCallback(() => {
    setTopic((current) => { if (current) queueMicrotask(() => focusBack('topic', current)); return null; });
  }, [focusBack]);
  // den-mvp/64: a seat, Bao or the table opens the meeting in the side sheet, on that seat's take when there is one.
  const openMeeting = useCallback((meeting, role, from) => {
    if (!meeting) return;
    releaseCursor();
    if (transcript.panel.agentId) transcriptClose.current?.();
    stamp('side', from);
    setMeetingId(meeting);
    setMeetingRole(role ?? null);
    setLeft((s) => (s.has(meeting) ? new Set([...s].filter((id) => id !== meeting)) : s));
  }, [transcript.panel.agentId, releaseCursor]);
  const closeMeeting = useCallback(() => { setMeetingId(null); queueMicrotask(() => focusBack('side', 'meetings')); }, [focusBack]);
  const leaveMeeting = useCallback(() => {
    setLeft((s) => new Set([...s, meetingId]));
    closeMeeting();
  }, [meetingId, closeMeeting]);
  const closeSide = useCallback(() => {
    if (meetingId) closeMeeting();
    else transcript.close();
  }, [meetingId, closeMeeting, transcript.close]);
  const sideOpen = !!(transcript.panel.agentId || meetingId);

  const [exploreHint,setExploreHint]=useState('WASD / arrows to walk · drag to look · Esc to leave');
  const onDenReady=useCallback(value=>setDen(value),[]);
  const sceneEvents=useMemo(()=>state=>denEvents(defaultEvents(state),stage),[stage]);
  const selectTicket=useCallback(ref=>{stage.explorer?.exit();setPicked(null);setSelected(ref);},[stage]);
  const pickPanda=useCallback(id=>{setSelected(null);setPicked(id);},[]);
  const unpick=useCallback(()=>{setPicked(null);setNearby(null);},[]);
  const closeTicket=useCallback(()=>{setSelected(null);document.querySelector(SCENE)?.focus({preventScroll:true});},[]);
  const onExploreChange=useCallback(active=>{setExploring(active);setNearby(null);setPicked(null);if(active)setSelected(null);},[]);

  // Escape (spec 1.6): an open inline confirm, then the last sheet opened, then the selected card, then walk mode (left to
  // the explorer). It runs first, in the capture phase on window, and a press that closes something is taken, so the
  // explorer and the panels' own Escape never also act on it. The permission review and the message box keep their keys.
  const escapeState = useRef({});
  escapeState.current = { topic, sideOpen, meetingId, picked, selected, exploring, closeTopic, closeSide, closeTicket, unpick, transcript };
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (approvalOpen.current || reviewOpen.current) return;
      const s = escapeState.current;
      const layers = [s.topic ? { slot: "topic", at: opened.current.topic } : null, s.sideOpen ? { slot: "side", at: opened.current.side } : null].filter(Boolean).sort((a, b) => a.at - b.at);
      const confirms = document.querySelectorAll('[data-confirm]');
      const action = escapeAction({ layers, confirming: confirms.length > 0, picked: s.picked != null || s.selected != null, walking: s.exploring });
      if (!action || action === "walk") return;
      const take = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (action === "confirm") {
        const keep = confirms[confirms.length - 1]?.querySelector('button:last-child');
        take(); keep?.click(); return;
      }
      if (action === "sheet") {
        const top = layers.at(-1).slot;
        take();
        // The thread's own use for Escape (its stop confirm) comes first.
        if (top === "side" && !s.meetingId && s.transcript.intercept.current?.()) return;
        if (top === "topic") s.closeTopic(); else s.closeSide();
        return;
      }
      if (action === "deselect") {
        take();
        if (s.selected) s.closeTicket(); else { s.unpick(); document.querySelector(SCENE)?.focus({ preventScroll: true }); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Entering or leaving Demo mode: walk mode exits, the sheets and panels close, the nearby card clears, and focus stays on the rail entry.
  onDemoChange.current = () => {
    stage.explorer?.exit();
    transcript.close(); message.composer.close(); approval.review.close();
    setTopic(null); setMeetingId(null);
    setNearby(null); setSelected(null); setPicked(null);
    setTimeout(() => document.querySelector('[data-rail="demo"]')?.focus({ preventScroll: true }), 0);
  };
  const frontier=snapshot?.frontier ?? [];
  const placements = useMemo(() => (snapshot ? sceneFromState(snapshot) : []), [snapshot]);
  // Bao's crown always holds the Pass: an idle stand-in when no orchestrator work is active.
  const scenePlacements = useMemo(() => withPassPlacement(placements), [placements]);
  // den-mvp/64: a meeting's runs wear the meeting's own labels at the table, so their generic chips are left out.
  const tableRef = tableMeeting(snapshot?.meetings, now)?.ref ?? null;
  const sceneChips=useMemo(()=>[...placements.filter(c=>c.ref!==tableRef),...frontier.map(ref=>({ref,role:'queued',pose:'idle'}))],[placements,frontier,tableRef]);
  const handoffs = useHandoffs(snapshot);
  const { metrics, failed: metricsFailed, retry: retryMetrics } = useMetrics(metricsRevision);
  const dashboard = useMemo(() => dashboardModel(metrics, { error: metricsFailed }), [metrics, metricsFailed]);
  const tally = useMemo(() => tallyRods(snapshot?.usage ?? null, dashboard, now), [snapshot?.usage, dashboard, now]);
  // The abacus in the scene opens the Tally sheet, like the rail's Tally entry.
  const openTally = useCallback(() => {
    if (topic !== 'tally') openTopic('tally', document.querySelector('[data-rail="tally"]'));
  }, [topic, openTopic]);
  const hearts = useMemo(() => new Set(handoffs.map((h) => h.ref)), [handoffs]);
  // den-mvp/22 (v5 wave 1): the repair bench and the archive. Marks come from this one snapshot (no second event stream);
  // a click only opens a sheet or a thread. Demo mode and a dropped bridge turn the work actions off and say why.
  const zonePhase = inDemo ? "offline" : connection.phase;
  const archiveLibrary = useArchiveLibrary({ rev: snapshot?.libraryRev ?? 0, enabled: zonePhase === "live" });
  const zoneView = useMemo(() => viewFromBridge({
    snapshot, actors: liveActorsFromSnapshot(snapshot, { now }), library: archiveLibrary, connection: { phase: zonePhase }, selectedRef: selected, now,
  }), [snapshot, archiveLibrary, zonePhase, selected, now]);
  const atTable = tableMeeting(snapshot?.meetings, now);
  const claimKey = atTable ? `${atTable.id}:${atTable.seats.map(s => `${s.status}${s.takes ?? 0}`).join(',')}` : '';
  const [claims, setClaims] = useState({});
  useEffect(() => {
    if (!atTable || inDemo || steering.state === 'none') { setClaims({}); return; }
    let current = true;
    bridge.getMeeting(atTable.id).then(body => {
      if (!current) return;
      const out = {};
      for (const t of [...body.takes].sort((a, b) => (a.n ?? 1) - (b.n ?? 1))) out[t.role] = claimOf(t.text) ?? out[t.role];
      setClaims(out);
    }, () => {});
    return () => { current = false; };
  }, [claimKey, bridge, inDemo, steering.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const residentCard = useCallback(row => {
    const boundRefs=new Set([...bindings.values()].map(boundAgentKey));
    return pickedCard([{...row,agent:agentFor(row,snapshot?.agents,boundRefs)}],snapshot?.approvals,row.id);
  },[bindings,snapshot?.agents,snapshot?.approvals]);
  const residentTalkState = useCallback(row => {
    if(row.runtime==='codex')return {enabled:false,reason:RUNTIME_UNAVAILABLE};
    if(inDemo)return {enabled:false,reason:'Leave the demo to talk to a panda.'};
    if(connection.phase!=='live')return {enabled:false,reason:'Reconnect to the den to open a conversation.'};
    const card=residentCard(row);
    if(card?.actions.R.enabled&&card.threadId)return {enabled:true};
    if(card?.actions.T.enabled)return steering.state==='none'
      ? {enabled:false,reason:'This view is read-only. Sign in to start a conversation.'}
      : {enabled:true};
    return {enabled:false,reason:'This resident does not have an agent runtime yet.'};
  },[inDemo,connection.phase,residentCard,steering.state]);
  // A Team row's Talk opens the conversation beside Team (Team stays open), or the message box on the resident's card.
  const talkToResident = useCallback(row => {
    if(!residentTalkState(row).enabled)return;
    const card=residentCard(row);
    approval.review.close();message.composer.close();
    if(card.actions.R.enabled&&card.threadId)openConversation(card.threadId,{name:row.name,role:row.role,state:card.state});
    else {setSelected(null);setPicked(row.id);setNearby(card);message.openFrom(card);}
  },[residentTalkState,residentCard,approval.review,message.composer,message.openFrom,openConversation]);
  const viewResidentWork = useCallback(row => {
    if(row.runtime==='codex'||!row.ref)return;
    selectTicket(row.ref);
  },[selectTicket]);
  const [zoneNotice, setZoneNotice] = useState(null);
  useEffect(() => {
    if (!zoneNotice) return undefined;
    const timer = setTimeout(() => setZoneNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [zoneNotice]);
  const zoneClick = useCallback((id) => {
    setZoneNotice(null);
    routeWorkClick(id, zoneView, {
      onOpenTicket: (intent) => { if (intent.ref) selectTicket(intent.ref); },
      onOpenRole: (intent) => {
        const agent = agentFor({ role: intent.role }, snapshot?.agents);
        if (agent) openConversation(agent.id, { name: intent.role, role: intent.role, state: agent.state });
        else setZoneNotice(`No ${intent.role} conversation yet: nothing has run for that role.`);
      },
      onOpenLibrary: () => openTopic('library', document.querySelector('[data-rail="library"]')),
      onUnavailable: (intent) => setZoneNotice(`${intent.label}: ${unavailableReason(zonePhase)}`),
    });
  }, [zoneView, zonePhase, snapshot?.agents, selectTicket, openConversation, openTopic]);
  const baoOpen = transcript.panel.agentId === DESK_THREAD;
  const talkToBao = useCallback((from) => {
    if (baoOpen) closeSide();
    else openConversation(DESK_THREAD, { name: 'Bao', role: 'orchestrator' }, from);
  }, [baoOpen, closeSide, openConversation]);
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);
  const onRail = useCallback((id, from) => {
    if (id === 'bao') talkToBao(from);
    else if (id === 'demo') denDemoMode.toggle();
    else if (id === 'reset') { camera.goToLevel(1); setToast('Back to the whole den'); }
    else openTopic(id, from);
  }, [talkToBao, denDemoMode, camera, openTopic]);
  const activity = useMemo(() => deskActivity(snapshot, { now, residents:SCENE_RESIDENTS }), [snapshot, now]);
  const badges = useMemo(() => railBadges({ snapshot, now, ownBuild: inDemo ? null : live.ownBuild }), [snapshot, now, inDemo, live.ownBuild]);
  const overflow = snapshot ? Math.max(0, activeCount(snapshot) - MAX_PLUSH) : 0;
  const floatOpen = !!(selected || approval.state.open || message.state.open || (engaged && shownCard));
  return (
    <div className={`shell procedural-den forest-shell den-shell${exploring ? " den-visiting" : ""}${cursorFree ? " den-cursor-free" : ""}${!exploring && picked != null ? " den-picked" : ""}`}>
      <header className="den-bar">
        <LogoPill connection={connection} demo={denDemo.active} />
        <button type="button" className="btn btn-solid den-bar-talk" aria-pressed={baoOpen} onClick={(e) => talkToBao(e.currentTarget)}>Talk to Bao</button>
      </header>
      <Rail topic={topic} baoOpen={baoOpen} badges={badges} onEntry={onRail} buildLabel={buildLabel(snapshot?.build)} demoActive={denDemo.active} offline={!inDemo && connection.phase !== 'live'} />
      <div className="den-stage">
        <div className="den-camera-controls">
          <ZoomSwitcher camera={camera} />
          <div role="group" aria-label="Roof visibility" className="den-roof-controls">
            {['full','cutaway'].map(mode=><button key={mode} type="button" className="btn btn-outline" aria-pressed={roofMode===mode} onClick={()=>{roofs.set(mode);setRoofMode(mode);}}>{mode==='full'?'Full roofs':'Cutaway'}</button>)}
          </div>
        </div>
        <main aria-label="Den scene" aria-describedby="den-navigation-hint" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown + -" tabIndex={0} className="scene forest-garden">
          <div className="forest-canvas">
            <SceneBoundary>
              <Canvas aria-hidden="true" orthographic shadows dpr={[1,1.5]} frameloop="demand"
                camera={{ manual: true, zoom: 1, near: 0.1, far: 160 }}
                gl={{antialias:true,powerPreference:'high-performance'}} events={sceneEvents} onPointerMissed={() => { setSelected(null); unpick(); }}>
                <FrameCap />
                <CameraRig store={camera} stage={stage} den={den} onModeChange={onExploreChange} onHint={setExploreHint} onCursorChange={setCursorFree} onLocationChange={setWalkPlace} />
                <Suspense fallback={null}>
                  <MeshyDen snapshot={snapshot} bindings={bindings} onScenePresentations={onScenePresentations} onLoadState={setGardenLoad} placements={scenePlacements} frontier={frontier} tally={tally} onOpenTally={openTally}
                    selected={selected} onSelect={selectTicket} stage={stage} onReady={onDenReady} onNearby={onNearby} picked={picked} onPick={pickPanda} zoneView={zoneView} onZoneClick={zoneClick} onOpenMeeting={(meeting, role) => openMeeting(meeting, role)} />
                </Suspense>
              </Canvas>
            </SceneBoundary>
            <ChipLayer placements={sceneChips} labelsOverride={MESHY_TEAM_LABELS} hearts={hearts} tally={tally} tallyOpen={topic === 'tally'} tickets={snapshot?.tickets} selected={selected} onSelect={selectTicket} stage={stage} />
            <ToolBubbleLayer bindings={bindings} stage={stage} onInspect={inspectTools} picked={picked} selected={selected} />
            <MeetingLayer snapshot={snapshot} stage={stage} claims={claims} onOpen={(meeting, role) => openMeeting(meeting, role)} />
            <div className="den-crosshair" aria-hidden="true" hidden={!exploring || cursorFree}>+</div>
            {exploring ? <p className="den-location" role="status" aria-label="Current location">{walkPlace}</p> : null}
            {!den ? <p className="forest-loading" role={gardenLoad.status === 'error' ? 'alert' : 'status'}>{gardenLoad.message}<span>{gardenLoad.status === 'error' ? 'Your board controls are still available on the rail.' : 'Preparing Bao, the workspaces and their props.'}</span></p> : null}
            {zoneNotice ? <p className="scene-caption scene-zone-notice" role="status">{zoneNotice}</p> : null}
            {toast ? <p className="scene-caption den-toast" role="status">{toast}</p> : null}
            {overflow > 0 ? <p className="scene-caption scene-more">+{overflow} more in queue</p> : null}
            <nav className="den-walk-pad" aria-label="Walk around the den" hidden={!exploring}>
              <button type="button" data-den-walk="KeyW" aria-label="Walk forward">↑</button>
              <button type="button" data-den-walk="KeyA" aria-label="Walk left">←</button>
              <button type="button" data-den-walk="KeyS" aria-label="Walk backward">↓</button>
              <button type="button" data-den-walk="KeyD" aria-label="Walk right">→</button>
            </nav>
            <div className="forest-legend" aria-label="Garden activity">
              <span><i className="forest-dot" />{activity.working} working</span>
              <span><i className="forest-dot state-needs-you" />{activity.waiting} need you</span>
              {activity.blocked > 0 ? <span><i className="forest-dot state-blocked" />{activity.blocked} blocked</span> : null}
              <span><i className="forest-dot state-resident" />{activity.resting} resting</span>
            </div>
            <div className="den-entry">
              <button type="button" className="btn btn-solid" aria-pressed={exploring} aria-disabled={!den || undefined}
                onClick={()=>{if(stage.explorer?.active)stage.explorer.exit();else stage.explorer?.enter();}}>
                {exploring?'Back to the diorama · Esc':'Enter the den'}
              </button>
              {exploring && cursorFree ? <button type="button" className="btn btn-outline" onClick={()=>{
                document.querySelector(SCENE)?.focus({preventScroll:true});
                stage.explorer?.capture();
              }}>Look around</button> : null}
            </div>
            <p id="den-navigation-hint" className="forest-garden-hint">{exploring ? exploreHint : 'Drag / arrows to orbit · Shift-drag / Shift-arrows / right-drag to pan · scroll / pinch to zoom · Den to reset'}</p>
          </div>
        </main>
        <Cards snapshot={snapshot} ownBuild={inDemo ? null : live.ownBuild} now={now} connection={connection} placeholder={placeholder} camera={camera} steering={steering}
          onAnswer={inDemo ? null : answerRequest} onOpenThread={inDemo ? null : openThread} onOpenTicket={selectTicket} demo={inDemo}
          topic={topic} onCloseTopic={closeTopic} onTopic={(id) => openTopic(id)} meetingId={meetingId} meetingRole={meetingRole}
          onShowMeeting={(id, from) => openMeeting(id, null, from)} onCloseMeeting={closeMeeting} onLeaveMeeting={leaveMeeting} left={left} />
        {topic === 'team' ? (
          <Sheet id="sheet-topic" slot="topic" eyebrow={SHEET_HEADS.team[0]} title={SHEET_HEADS.team[1]} closeLabel="Close panel" onClose={closeTopic} focusKey="team">
            <Residents snapshot={snapshot} now={now} bindings={bindings} scenePresentations={scenePresentations} onInspectTools={inspectTools} onTalk={talkToResident} onViewWork={viewResidentWork} getTalkState={residentTalkState} />
            <p className="forest-muted">{SCENE_RESIDENTS.length} garden residents{activity.visitors > 0 ? ` · ${activity.visitors} visiting agents` : ''}. All callable roles and runs remain available in Team.</p>
          </Sheet>
        ) : null}
        {topic === 'replay' ? (
          <Sheet id="sheet-topic" slot="topic" eyebrow={SHEET_HEADS.replay[0]} title={SHEET_HEADS.replay[1]} closeLabel="Close panel" onClose={closeTopic} focusKey="replay" wide>
            <AuditReplay initialId={replayId} />
          </Sheet>
        ) : null}
        {topic === 'tally' ? (
          <Sheet id="sheet-topic" slot="topic" eyebrow={SHEET_HEADS.tally[0]} title={SHEET_HEADS.tally[1]} closeLabel="Close panel" onClose={closeTopic} focusKey="tally">
            <TallyBody tally={tally} metrics={metrics} failed={metricsFailed} onRetry={retryMetrics} />
          </Sheet>
        ) : null}
        <TranscriptPanel tx={transcript} transcripts={denDemo.transcripts ?? live.transcripts} agents={snapshot?.agents} approvals={inDemo ? null : snapshot?.approvals} onAnswer={answerAgent} connection={denDemo.active ? { phase: "live" } : connection}
          client={bridge} signedIn={steering.state !== "none"} demo={inDemo} />
        <aside className="den-float" aria-label="Selected" hidden={!floatOpen}>
          {selected?<PandaCard snapshot={snapshot} selected={selected} onClose={closeTicket} />:null}
          <div className="proximity-dock" hidden={!!(selected || approval.state.open)}>
            {engaged ? <ProximityCard card={shownCard} toolActivity={bindings.get(shownCard?.id)?.toolActivity} onInspectTools={()=>inspectTools(bindings.get(shownCard?.id))} onClose={exploring ? null : unpick} onTranscript={(c) => { if (!reviewOpen.current) transcript.toggle(c); }} onAnswer={approval.openFrom}
              onMessage={(c) => { if (!approvalOpen.current) message.openFrom(c); }} status={denDemo.active ? denDemoMode.statusFor(nearby) : message.composer.statusFor(nearby)} demo={inDemo} transcriptOpen={!!transcript.panel.agentId} /> : null}
            <MessageComposer composer={message.composer} state={message.state} />
          </div>
          <ApprovalPanel review={approval.review} state={approval.state} />
        </aside>
      </div>
      {denDemo.active ? <DemoStrip loops={denDemo.loops} /> : null}
      <DemoAnnouncer text={denDemo.announcement} />
    </div>
  );
}
