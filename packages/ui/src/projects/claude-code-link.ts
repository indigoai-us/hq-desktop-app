/**
 * Compatibility re-export: the canonical Claude Code deep-link builder lives
 * in the files area (ported alongside OpenFileInClaudeCode). Projects-area
 * consumers (and the company area's agent-workflow) import it from here.
 */
export * from "../files/claude-code-link.js";
