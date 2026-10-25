// The same authenticated MCP transport as Bao's den tools, with only managed delegation exposed.
process.env.DEN_DELEGATION_ONLY = '1';
await import('./den.mjs');
