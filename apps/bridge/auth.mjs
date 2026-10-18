// organism-infra/139 (ADR 0016 decision 6.2): launch codes and session tokens, held in memory only.
//   - A launch code is 32 random bytes, valid for ttlMs (5 minutes), redeemable once, and burned (with every other
//     live code) after FAILED_LIMIT wrong guesses.
//   - A redeemed code becomes a session token: 32 random bytes, no expiry, at most SESSION_CAP live at once. The
//     fifth redemption is refused (429), never evicting an earlier session, so an attacker cannot log the user out.
//   - Codes and tokens are stored as sha256 digests and compared with timingSafeEqual; nothing here logs.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const LAUNCH_CODE_TTL_MS = 5 * 60_000;
export const FAILED_LIMIT = 5;
export const SESSION_CAP = 4;

const digest = (s) => createHash("sha256").update(String(s)).digest();
const newSecret = () => randomBytes(32).toString("base64url");
const sameDigest = (a, b) => timingSafeEqual(a, b);

// Only launchCode, ttlMs, now and serviceToken are read: no other option can disable the gate or preset a session token.
// den-mvp/88: serviceToken is the router's credential (32 to 512 base64url characters, else ignored). It is not a session:
// it takes no slot under SESSION_CAP, and only verifyService accepts it, on the routes marked `service: true`.
export function createAuth({ launchCode, ttlMs = LAUNCH_CODE_TTL_MS, now = Date.now, serviceToken } = {}) {
  const service = typeof serviceToken === "string" && /^[A-Za-z0-9_-]{32,512}$/.test(serviceToken) ? digest(serviceToken) : null;
  let codes = []; // { hash, issuedAt }
  const sessions = []; // sha256 digests of live tokens
  let failures = 0;

  const mint = (code) => {
    codes.push({ hash: digest(code), issuedAt: now() });
    return code;
  };
  if (typeof launchCode === "string" && launchCode) mint(launchCode);

  // Resolves { status: 200, token } | { status: 401 } | { status: 429 }. `code` is a string.
  function redeem(code) {
    const h = digest(code);
    const t = now();
    const hit = codes.findIndex((c) => sameDigest(c.hash, h));
    const live = hit >= 0 && t - codes[hit].issuedAt <= ttlMs;
    if (!live) {
      if (hit >= 0) codes.splice(hit, 1); // an expired code stays dead
      if (++failures >= FAILED_LIMIT) {
        codes = [];
        failures = 0;
      }
      return { status: 401 };
    }
    if (sessions.length >= SESSION_CAP) return { status: 429 }; // the code is not spent by a refusal
    codes.splice(hit, 1);
    const token = newSecret();
    sessions.push(digest(token));
    return { status: 200, token };
  }

  // `header` is the raw Authorization value. Anything but "Bearer <token>" with a known token is false.
  function verify(header) {
    const m = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(typeof header === "string" ? header : "");
    if (!m) return false;
    const h = digest(m[1]);
    let ok = false;
    for (const s of sessions) if (sameDigest(s, h)) ok = true;
    return ok;
  }

  function verifyService(header) {
    const m = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(typeof header === "string" ? header : "");
    return !!(service && m && sameDigest(service, digest(m[1])));
  }

  return { newLaunchCode: () => mint(newSecret()), redeem, verify, verifyService };
}
