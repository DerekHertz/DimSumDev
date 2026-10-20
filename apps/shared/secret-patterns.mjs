// Shared disclosure patterns: browser and bridge use the same policy.
export const SECRET_PATTERNS = [
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    name: "hardcoded API key/token/secret",
    re: /\b(api[_-]?key|token|secret)\b\s*[:=]\s*["'][A-Za-z0-9_\-/+]{12,}["']/i,
  },
  {
    name: "env-file credential line",
    re: /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?)[ \t]*=[ \t]*["']?[A-Za-z0-9_\-/+=]{12,}["']?[ \t]*$/m,
  },
  { name: "AWS secret access key", re: /\baws_secret_access_key\b[ \t]*[:=][ \t]*["']?[A-Za-z0-9/+=]{20,}/i },
  { name: "Authorization bearer token", re: /\bAuthorization:[ \t]*Bearer[ \t]+[A-Za-z0-9._~+/=-]{16,}/i },
  {
    name: "JWT",
    re: /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\.(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\.(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/,
  },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "GitHub fine-grained token", re: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: "sk- style API key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "Stripe-style live/test key", re: /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: "npm token", re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/ },
  { name: "Slack token", re: /(?<![A-Za-z0-9])xox[abprse]-[A-Za-z0-9-]{10,}/ },
  { name: "URL credentials", re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]+:[^\s:@/$<>{}]{3,}@[^\s/]+/i },
  { name: "hardcoded password=style credential", re: /\bpassword\s*[:=]\s*["'][^"']{3,}["']/i },
];

export function hasSecret(text) {
  return SECRET_PATTERNS.some((p) => p.re.test(String(text ?? "")));
}

