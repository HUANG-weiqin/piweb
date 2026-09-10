import { roslyn } from "./roslyn.js";
import { typescript } from "./typescript.js";

// Extending this catalogue does not change tools, transport or workspace ownership.
export const lspServerProfiles = [roslyn, typescript] as const;
