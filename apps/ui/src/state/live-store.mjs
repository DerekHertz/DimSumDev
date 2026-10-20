// State holder a React component subscribes to. The EventSource and fetch are injected.
import { applyEvent } from "./apply-event.mjs";
import { initialConnection, connectionReducer } from "./connection.mjs";
import { appendTranscript, entryFromFrame, seedTranscripts } from "./transcript-buffer.mjs";
import { observeTools, reconcileTools } from './tool-activity.mjs';

export function createLiveStore({ connect, fetchState, now }) {
  // ownBuild (den-mvp/12): the live build in the first snapshot this page got, which is the build the page was made from.
  // It is never replaced, so a later snapshot or build frame that names another build means a new version went live.
  let state = { snapshot: null, connection: initialConnection(now()), metricsRevision: 0, transcripts: {}, toolActivity: {}, ownBuild: null };
  const listeners = new Set();
  let handle = null;
  let closed = false;

  const set = (patch) => {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  };
  const conn = (type) => connectionReducer(state.connection, { type, now: now() });
  // Every snapshot (first load, reconnect, refetch) carries what the bridge kept of each transcript; it replaces
  // those agents' buffers, so nothing is lost or doubled across a gap.
  const withSnapshot = (snapshot) => ({ snapshot, connection: conn("snapshot"), toolActivity: reconcileTools(state.toolActivity,snapshot), transcripts: seedTranscripts(state.transcripts, snapshot?.transcripts), ownBuild: state.ownBuild ?? snapshot?.build?.live?.sha ?? null });

  async function refetch() {
    try {
      const snapshot = await fetchState();
      if (closed) return;
      set(withSnapshot(snapshot));
    } catch {
      // the stream's error handling owns the connection state
    }
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      closed = false;
      handle = connect({
        onOpen: () => {
          if(closed)return;
          const c = conn("open");
          if (c !== state.connection) set({ connection: c });
        },
        onSnapshot: (snapshot) => {if(!closed)set(withSnapshot(snapshot));},
        onChange: (event) => {
          if(closed)return;
          if (!state.snapshot) return;
          if (event.seq <= state.snapshot.seq) return; // replay is not a connection gap
          // Transcript entries ride the normal seq sequence; buffer a frame once (a replayed seq is skipped).
          const line = event.seq > state.snapshot.seq ? entryFromFrame(event) : null;
          if (line) state = { ...state, transcripts: appendTranscript(state.transcripts, line.agentId, line.entry), toolActivity: observeTools(state.toolActivity,line.agentId,line.entry) };
          const next = applyEvent(state.snapshot, event);
          if (!next) {
            set({connection:conn('error')}); // a sequence gap cannot support a live assertion
            refetch();
            // refetch() does not notify until the snapshot arrives, so publish a buffered line now.
            if (line) set({});
            return;
          }
          const patch = { snapshot: next };
          if(event.type==='agent'&&event.agent?.id&&!['working','waiting_on_user','needs-you','blocked','throttled','idle'].includes(event.agent.state))patch.toolActivity=observeTools(state.toolActivity,event.agent.id,{kind:'ended'});
          if (event.type === "metrics-changed") patch.metricsRevision = state.metricsRevision + 1;
          set(patch);
        },
        onError: () => {
          if(closed)return;
          const c = conn("error");
          if (c !== state.connection) set({ connection: c });
        },
      });
    },
    tick() {
      const c = conn("tick");
      if (c !== state.connection) set({ connection: c });
    },
    close() {
      closed = true;
      handle?.close();
      handle = null;
      state = { ...state, toolActivity: {} };
    },
  };
}
