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
import { TallyCard } from "./scene/TallyCard.jsx";
import { useNow } from "./panel/Panel.jsx";
import { answerCardFor, needsYouModel } from "./overlay/overlay-model.mjs";
import { panelPlaceholder } from "./state/connection.mjs";
import { createCameraStore } from "./scene/camera-store.mjs";
import { LogoPill, Cards } from "./overlay/Cards.jsx";
import { useSession } from "./session/useSession.js";
import { ZoomSwitcher } from "./overlay/Bottom.jsx";
import { DemoAnnouncer, DemoButton, DemoStrip, useDemoMode } from "./demo/DemoControls.jsx";
import { demoCard } from "./demo/demo-card.mjs";
import { viewFromBridge } from "./scene/expansion/integration/bridge-adapter.mjs";
import { routeWorkClick, unavailableReason } from "./scene/expansion/work-zones.mjs";
import { useArchiveLibrary } from "./scene/expansion/archive-library.js";
import { liveActorsFromSnapshot } from "./review/live-actors.mjs";
import { agentFor, pickedCard } from "./overlay/proximity-card.mjs";
import { DESK_THREAD } from "./overlay/transcript-panel.mjs";
import { Residents } from "./shell/Residents.jsx";
import { deskActivity } from "./shell/desk-model.mjs";
import { actorBindings, NAVIGATION_TARGETS, MESHY_TEAM_LABELS } from "./scene/meshy/layout.mjs";
import { MeetingLayer } from "./scene/MeetingLayer.jsx";
import { claimOf, tableMeeting } from "./scene/meshy/meeting-table.mjs";
import { RESIDENTS, RUNTIME_UNAVAILABLE, boundAgentKey } from './shell/resident-inventory.mjs';

class SceneBoundary extends Component {
  state={error:null};
  static getDerivedStateFromError(error){return {error};}
  render(){return this.state.error?<p className="den-error" role="alert">The 3D den could not load. Your board controls are still available. Reload to try again.</p>:this.props.children;}
}

const noSubscribe = () => () => {};
const noSnapshot = () => null;

function activeCount(snapshot) {
  const active = new Set(["claimed", "in-review", "blocked", "ready-for-human"]);
  const refs = new Set(snapshot.tickets.filter((t) => active.has(t.status)).map((t) => t.ref));
  for (const r of snapshot.frontier ?? []) refs.add(r);
  return refs.size;
}

export function App() {
  const live = useLiveState();
  const steering = useSession();
  const [demo] = useState(demoRequested);
  const demoSnapshot = useDemoSnapshot(demo);
  // den-v1/09: Demo mode replays recorded events into the den (demo/). It reads no session and makes no request.
  const onDemoChange = useRef(() => {});
  const [denDemo, denDemoMode] = useDemoMode((active) => onDemoChange.current(active));
  const demoButton = useRef(null);
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
  const camera = useMemo(() => createDenCameraStore(createCameraStore({minZoom:.25,levels:{1:1,2:.4,3:.25}}),()=>stage.explorer?.exit(), NAVIGATION_TARGETS), [stage]);
  const [den,setDen]=useState(null);
  const [gardenLoad, setGardenLoad] = useState({ status: 'loading', message: 'Opening the garden…' });
  const [exploring,setExploring]=useState(false);
  const [cursorFree, setCursorFree] = useState(false);
  const [nearby, setNearby] = useState(null);
  // Overview (live den run, 2026-10-10): a clicked panda shows the card walk mode shows. `engaged` is walk mode or a
  // picked panda: the transcript, the permission review and the message box stay open, and their keys act, in either.
  const [picked, setPicked] = useState(null);
  const engaged = exploring || picked != null;
  const now = useNow();
  const previousBindings = useRef(new Map());
  const bindings = useMemo(() => actorBindings(liveActorsFromSnapshot(snapshot, { now }), previousBindings.current), [snapshot, now]);
  useEffect(() => { previousBindings.current = bindings; }, [bindings]);
  const requests = useMemo(() => needsYouModel(snapshot, now).requests, [snapshot, now]);
  const onNearby = useCallback(card => setNearby(previous => JSON.stringify(previous) === JSON.stringify(card) ? previous : card), []);
  const releaseCursor = useCallback(() => stage.explorer?.freeCursor?.(), [stage]);
  const reviewOpen = useRef(false);
  const approvalOpen = useRef(false);
  const transcriptClose = useRef(null);
  const messageClose = useRef(null);
  // In Demo mode the card is routed through demoCard: T, E and Q greyed, R on only when a transcript line was recorded.
  const shownCard = useMemo(() => (denDemo.active ? demoCard(nearby, { transcripts: denDemo.transcripts }) : nearby), [nearby, denDemo.active, denDemo.transcripts]);
  const transcript = useTranscript({ card: shownCard, exploring: engaged, onOpen: releaseCursor, blocked: reviewOpen });
  transcriptClose.current = transcript.close;
  const bridge = useMemo(() => approvalDemo?.client ?? createBridgeClient({ fetch: steering.session.fetch }), [steering.session, approvalDemo]);
  const onReviewOpen = useCallback(() => { transcriptClose.current?.(); messageClose.current?.(); releaseCursor(); }, [releaseCursor]);
  // E and Q answer the panda card in view, or else the first waiting permission request (overlay-model.mjs answerCardFor).
  const answerCard = useMemo(() => answerCardFor(nearby, requests), [nearby, requests]);
  const approval = useApprovalReview({ client: bridge, card: answerCard, exploring: engaged, cursorFree, demo: inDemo, snapshot, onOpen: onReviewOpen });
  // den-mvp/37: an agent's question is answered in its thread, where its options are; a tool ask opens the review.
  const asksQuestion = (card) => (snapshot?.approvals ?? []).some((a) => a.agentId === card.agentId && a.state === "pending" && Array.isArray(a.questions));
  const answerRequest = useCallback((card) => {
    if (!card) return;
    if (asksQuestion(card)) transcript.openFor(card.agentId, { name: card.name, role: card.role, state: card.state });
    else approval.review.open(card, { mode: "card", demo: inDemo });
  }, [approval.review, inDemo, snapshot, transcript.openFor]);
  const answerAgent = useCallback((agentId) => answerRequest(requests.find((r) => r.card?.agentId === agentId)?.card), [answerRequest, requests]);
  // organism-infra/230: "Open thread" on a Needs you card opens that agent's conversation, in or out of walk mode.
  const openThread = useCallback((card) => { if (card?.agentId) transcript.openFor(card.agentId, { name: card.name, role: card.role, state: card.state }); }, [transcript.openFor]);
  // den-v1/07: T opens the message composer. A message the agent took shows on its transcript entry (den-v1 loop S5), which reaches the composer with each snapshot and frame.
  const message = useMessageComposer({ client: bridge, card: nearby, exploring: engaged, cursorFree, demo: inDemo, snapshot, transcripts: live.transcripts, onOpen: releaseCursor, blocked: approvalOpen });
  messageClose.current = message.composer.close;
  useEffect(() => approvalDemo?.onEvent((event) => message.composer.observe(event)), [approvalDemo, message.composer]); // dev-only demo acks (scene/approval-fixture.mjs)
  approvalOpen.current = approval.state.open;
  reviewOpen.current = approval.state.open || message.state.open; // the transcript keys stand down while either panel is open
  // Entering or leaving Demo mode: walk mode exits, the panels close, the nearby card clears, and focus stays on the button.
  onDemoChange.current = () => {
    stage.explorer?.exit();
    transcript.close(); message.composer.close(); approval.review.close();
    setNearby(null); setSelected(null); setPicked(null);
    setTimeout(() => demoButton.current?.focus({ preventScroll: true }), 0);
  };
  const [exploreHint,setExploreHint]=useState('WASD / arrows to walk · drag to look · Esc to leave');
  const onDenReady=useCallback(value=>setDen(value),[]);
  const sceneEvents=useMemo(()=>state=>denEvents(defaultEvents(state),stage),[stage]);
  const selectTicket=useCallback(ref=>{stage.explorer?.exit();setPicked(null);setSelected(ref);},[stage]);
  const pickPanda=useCallback(id=>{setSelected(null);setPicked(id);},[]);
  const unpick=useCallback(()=>{setPicked(null);setNearby(null);},[]);
  const closeTicket=useCallback(()=>{setSelected(null);document.querySelector('main[aria-label="Den scene"]')?.focus({preventScroll:true});},[]);
  const onExploreChange=useCallback(active=>{setExploring(active);setNearby(null);setPicked(null);if(active){setSelected(null);setTallyOpen(false);}},[]);
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
  // Tally expands into an in-place card over the scene (nothing scrolls). Esc, Close and the pill return
  // focus to the pill; an outside pointerdown closes without moving focus.
  const [tallyOpen, setTallyOpen] = useState(false);
  const openTally = useCallback(() => {
    stage.explorer?.exit();
    transcriptClose.current?.(); messageClose.current?.(); approval.review.close();
    setSelected(null); setPicked(null); setNearby(null); setTallyOpen(true);
  }, [stage, approval.review]);
  const closeTally = useCallback((restoreFocus = false) => {
    setTallyOpen(false);
    if (restoreFocus) document.querySelector(".chip-tally")?.focus({ preventScroll: true });
  }, []);
  const toggleTally = useCallback(() => {
    if (tallyOpen) closeTally(true);
    else openTally();
  }, [tallyOpen, openTally, closeTally]);
  const hearts = useMemo(() => new Set(handoffs.map((h) => h.ref)), [handoffs]);
  // den-mvp/22 (v5 wave 1): the repair bench and the archive. Marks come from this one snapshot (no second event stream);
  // a click only opens a card or a thread. Demo mode and a dropped bridge turn the work actions off and say why.
  const zonePhase = inDemo ? "offline" : connection.phase;
  const archiveLibrary = useArchiveLibrary({ rev: snapshot?.libraryRev ?? 0, enabled: zonePhase === "live" });
  const zoneView = useMemo(() => viewFromBridge({
    snapshot, actors: liveActorsFromSnapshot(snapshot, { now }), library: archiveLibrary, connection: { phase: zonePhase }, selectedRef: selected, now,
  }), [snapshot, archiveLibrary, zonePhase, selected, now]);
  const [libraryRequest, setLibraryRequest] = useState(0);
  const [deskSection, setDeskSection] = useState('home');
  const [focusRequest, setFocusRequest] = useState(null);
  const navigateDesk = useCallback((section) => {
    stage.explorer?.exit();
    transcript.close(); message.composer.close(); approval.review.close();
    setSelected(null); unpick(); setTallyOpen(false); setDeskSection(section);
    setFocusRequest(previous => ({ section, sequence: (previous?.sequence ?? 0) + 1 }));
  }, [stage, transcript.close, message.composer, approval.review, unpick]);
  // den-mvp/64: a seat, Bao or the table opens the meeting in the Meetings card, on that seat's take when there is one.
  const openMeeting = useCallback((meeting, role) => {
    navigateDesk('meetings');
    setFocusRequest(previous => ({ section: 'meetings', meeting, role: role ?? null, sequence: (previous?.sequence ?? 0) + 1 }));
  }, [navigateDesk]);
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
  const talkToResident = useCallback(row => {
    if(!residentTalkState(row).enabled)return;
    const card=residentCard(row);stage.explorer?.exit();
    approval.review.close();message.composer.close();transcript.close();
    setSelected(null);setTallyOpen(false);unpick();
    if(card.actions.R.enabled&&card.threadId)transcript.openFor(card.threadId,{name:row.name,role:row.role,state:card.state});
    else {setPicked(row.id);setNearby(card);message.openFrom(card);}
  },[residentTalkState,residentCard,stage,approval.review,message.composer,message.openFrom,transcript.close,transcript.openFor,unpick]);
  const viewResidentWork = useCallback(row => {
    if(row.runtime==='codex'||!row.ref)return;
    navigateDesk('pandas');selectTicket(row.ref);
  },[navigateDesk,selectTicket]);
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
        if (agent) transcript.openFor(agent.id, { name: intent.role, role: intent.role, state: agent.state });
        else setZoneNotice(`No ${intent.role} conversation yet: nothing has run for that role.`);
      },
      onOpenLibrary: () => { navigateDesk('library'); setLibraryRequest((n) => n + 1); },
      onUnavailable: (intent) => setZoneNotice(`${intent.label}: ${unavailableReason(zonePhase)}`),
    });
  }, [zoneView, zonePhase, snapshot?.agents, selectTicket, transcript.openFor, navigateDesk]);
  const activity = useMemo(() => deskActivity(snapshot, { now }), [snapshot, now]);
  const detailOpen = !!(selected || tallyOpen || approval.state.open || transcript.panel.agentId || message.state.open || (engaged && shownCard));
  const deskPanel = useRef(null);
  useEffect(() => {
    if (picked && !exploring && matchMedia('(max-width: 760px)').matches) deskPanel.current?.scrollIntoView({ block: 'start' });
  }, [picked, exploring]);
  const deskTitles = { home: 'Your desk.', work: 'Good work, in motion.', pandas: 'A home for every calling.', library: 'The shared library.' };
  const overflow = snapshot ? Math.max(0, activeCount(snapshot) - MAX_PLUSH) : 0;
  return (
    <div className={`shell procedural-den forest-shell${exploring ? " den-visiting" : ""}${cursorFree ? " den-cursor-free" : ""}${!exploring && picked != null ? " den-picked" : ""}`}>
      <header className="forest-masthead">
        <LogoPill connection={connection} demo={denDemo.active} />
        <nav className="forest-navigation" aria-label="Workspace">
          {[["home", "The Den"], ["work", "Work"], ["pandas", "Pandas"], ["library", "Library"]].map(([id, label]) =>
            <button key={id} type="button" aria-current={deskSection === id ? "page" : undefined} onClick={() => navigateDesk(id)}>{label}</button>)}
        </nav>
        <DemoButton ref={demoButton} state={denDemo} onToggle={denDemoMode.toggle} />
      </header>
      <section className="forest-welcome" aria-label="Welcome">
        <div><p className="forest-eyebrow">YOUR LITTLE WORLD AT WORK</p><h2>Welcome to the Den.</h2><p>Room to think. A table to come back to.</p></div>
        <button type="button" className="btn btn-solid forest-talk" onClick={() => transcript.openFor(DESK_THREAD, { name: 'Bao', role: 'orchestrator' })}>Talk to Bao <span aria-hidden="true">↗</span></button>
      </section>
      <div className="forest-workspace">
        <main aria-label="Den scene" aria-keyshortcuts="ArrowLeft ArrowRight + -" tabIndex={0} className="scene forest-garden">
          <header className="forest-garden-toolbar">
            <strong><span className="forest-dot" aria-hidden="true" /> Around the garden</strong>
            <button type="button" className="forest-link" onClick={() => camera.goToLevel(1)}>Reset view ↗</button>
          </header>
          <div className="forest-canvas">
            <SceneBoundary>
              <Canvas aria-hidden="true" orthographic shadows dpr={[1,1.5]} frameloop="demand"
                camera={{ manual: true, zoom: 1, near: 0.1, far: 160 }}
                gl={{antialias:true,powerPreference:'high-performance'}} events={sceneEvents} onPointerMissed={() => { setSelected(null); unpick(); }}>
                <FrameCap />
                <CameraRig store={camera} stage={stage} den={den} onModeChange={onExploreChange} onHint={setExploreHint} onCursorChange={setCursorFree} />
                <Suspense fallback={null}>
                  <MeshyDen snapshot={snapshot} bindings={bindings} onLoadState={setGardenLoad} placements={scenePlacements} frontier={frontier} tally={tally} onOpenTally={openTally}
                    selected={selected} onSelect={selectTicket} stage={stage} onReady={onDenReady} onNearby={onNearby} picked={picked} onPick={pickPanda} zoneView={zoneView} onZoneClick={zoneClick} onOpenMeeting={openMeeting} />
                </Suspense>
              </Canvas>
            </SceneBoundary>
            <ChipLayer placements={sceneChips} labelsOverride={MESHY_TEAM_LABELS} hearts={hearts} onToggleTally={toggleTally} tallyOpen={tallyOpen} tally={tally} tickets={snapshot?.tickets} selected={selected} onSelect={selectTicket} stage={stage} />
            <MeetingLayer snapshot={snapshot} stage={stage} claims={claims} onOpen={openMeeting} />
            <div className="den-crosshair" aria-hidden="true" hidden={!exploring || cursorFree}>+</div>
            {!den ? <p className="forest-loading" role={gardenLoad.status === 'error' ? 'alert' : 'status'}>{gardenLoad.message}<span>{gardenLoad.status === 'error' ? 'Your board controls are still available at the desk.' : 'Preparing Bao, the workspaces and their props.'}</span></p> : null}
            {zoneNotice ? <p className="scene-caption scene-zone-notice" role="status">{zoneNotice}</p> : null}
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
          </div>
          <footer className="forest-garden-footer">
            <ZoomSwitcher camera={camera} />
            <div className="den-entry">
              <button type="button" className="btn btn-solid" aria-pressed={exploring} aria-disabled={!den || undefined}
                onClick={()=>{if(stage.explorer?.active)stage.explorer.exit();else stage.explorer?.enter();}}>
                {exploring?'Leave the den':'Enter the den'}
              </button>
              {exploring && cursorFree ? <button type="button" className="btn btn-outline" onClick={()=>{
                document.querySelector('main[aria-label="Den scene"]')?.focus({preventScroll:true});
                stage.explorer?.capture();
              }}>Look around</button> : null}
            </div>
          </footer>
          <p className="forest-garden-hint">{exploring ? exploreHint : 'Drag to move around · scroll to zoom · select a panda to visit'}</p>
        </main>
        <aside ref={deskPanel} className={`forest-desk${detailOpen ? ' has-detail' : ''}`} aria-label="Your desk">
          <div className="forest-desk-home" hidden={detailOpen}>
            <header className="forest-desk-heading"><p className="forest-eyebrow">A LITTLE SPACE TO FOCUS</p><h2>{deskTitles[deskSection] ?? 'Your desk.'}</h2></header>
            <div hidden={deskSection === 'pandas'}>
              <Cards snapshot={snapshot} ownBuild={inDemo ? null : live.ownBuild} now={now} connection={connection} placeholder={placeholder} camera={camera} steering={steering} onAnswer={inDemo ? null : answerRequest} onOpenThread={inDemo ? null : openThread} onOpenTicket={selectTicket} demo={inDemo} libraryRequest={libraryRequest} focusRequest={focusRequest} />
            </div>
            {deskSection === 'pandas' ? <Residents snapshot={snapshot} now={now} bindings={bindings} onTalk={talkToResident} onViewWork={viewResidentWork} getTalkState={residentTalkState} /> : null}
          </div>
          {tallyOpen ? <TallyCard tally={tally} metrics={metrics} failed={metricsFailed} onRetry={retryMetrics} onClose={closeTally} stage={stage} /> : null}
          {selected?<PandaCard snapshot={snapshot} selected={selected} onClose={closeTicket} />:null}
          <div className="proximity-dock" hidden={!!(selected || tallyOpen || approval.state.open || transcript.panel.agentId)}>
            {engaged ? <ProximityCard card={shownCard} onClose={exploring ? null : unpick} onTranscript={(c) => { if (!reviewOpen.current) transcript.toggle(c); }} onAnswer={approval.openFrom}
              onMessage={(c) => { if (!approvalOpen.current) message.openFrom(c); }} status={denDemo.active ? denDemoMode.statusFor(nearby) : message.composer.statusFor(nearby)} demo={inDemo} transcriptOpen={!!transcript.panel.agentId} /> : null}
            <MessageComposer composer={message.composer} state={message.state} />
          </div>
          <ApprovalPanel review={approval.review} state={approval.state} />
          <TranscriptPanel tx={transcript} transcripts={denDemo.transcripts ?? live.transcripts} agents={snapshot?.agents} approvals={inDemo ? null : snapshot?.approvals} onAnswer={answerAgent} connection={denDemo.active ? { phase: "live" } : connection}
            client={bridge} signedIn={steering.state !== "none"} demo={inDemo} />
        </aside>
      </div>
      <footer className="forest-page-footer"><span>DIM SUM DEV <span aria-hidden="true">·</span> A place for good work.</span><span>{RESIDENTS.length} residents{activity.visitors > 0 ? ` · ${activity.visitors} visiting agents` : ''}</span></footer>
      {denDemo.active ? <DemoStrip loops={denDemo.loops} /> : null}
      <DemoAnnouncer text={denDemo.announcement} />
    </div>
  );
}
