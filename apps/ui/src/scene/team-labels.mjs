// showcase-v1/05: where the team labels float. Pure. One label per stall, above its roof apex,
// following the stall as it widens. ChipLayer projects the anchors and draws each on a rice-paper pill.
import { CUB_BASKET, STALL_CENTERS, stallCenterX, stallPlatform, stallRoof } from "./banquet-layout.mjs";
import { EAVE_Y, RISE } from "./stall-roof.mjs";

export const NAME = { steamers: "Steamers", "front-of-house": "Front of House", tea: "Tea", pantry: "Pantry", cubs: "Cubs" };
const ABOVE_APEX = 0.2;
/** Just above the cub basket's rim (0.4 tall). */
const CUB_BASKET_LABEL_Y = 0.65;

/** @param {Record<string, number>} counts placements per team */
export function teamLabels(counts) {
  // The cub basket is not a stall; its pill keeps it from being read as the lazy susan queue.
  const cubs = { id: "team:cubs", team: "cubs", text: NAME.cubs, x: CUB_BASKET.x, y: CUB_BASKET_LABEL_Y, z: CUB_BASKET.z };
  return [...Object.keys(STALL_CENTERS).map((team) => {
    const roof = stallRoof(team) ?? { eave: EAVE_Y, rise: RISE };
    return {
      id: `team:${team}`,
      team,
      text: NAME[team],
      x: stallCenterX(team, counts[team] ?? 0),
      y: stallPlatform(team) + roof.eave + roof.rise + ABOVE_APEX,
      z: STALL_CENTERS[team].z,
    };
  }), cubs];
}
