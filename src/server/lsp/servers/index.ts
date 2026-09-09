import { roslyn } from "./roslyn.js";

// Extending this catalogue does not change tools, transport or workspace ownership.
export const lspServerProfiles = [roslyn] as const;
