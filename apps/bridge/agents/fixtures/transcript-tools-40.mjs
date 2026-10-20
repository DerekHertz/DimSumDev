// Synthetic disclosure probes, assembled like approvals-mask.test.mjs. No real credentials.
export const secret = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
export const bearerBody = 'syntheticBearerProbe40abcdefgh';
export const privateBody = 'syntheticPrivateProbe40abcdefgh';
export const assignmentBody = 'syntheticAssignmentProbe40abcdefgh';
export const probes = [secret, bearerBody, privateBody, assignmentBody];
export const unsafeText = () => [
  `key ${secret}`,
  `Authorization: ${'Bear' + 'er'} ${bearerBody}`,
  `${'-----BEGIN ' + 'PRIVATE KEY-----'}\n${privateBody}\n${'-----END ' + 'PRIVATE KEY-----'}`,
  `API_TOKEN=${assignmentBody}`,
  `control:${String.fromCharCode(7)} bidi:${String.fromCharCode(0x202e)}`,
].join('\n');
export const source = (runId, entryId, overrides = {}) => ({ project: 'den', runtime: 'claude', role: 'architect', runId, entryId, ...overrides });
