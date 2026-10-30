import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentState } from "../types.ts";

export interface PetLink {
  emit: (state: AgentState, tool?: string) => void;
}

const MAX_BYTES = 1_000_000;

/**
 * Writes the local JSONL state bus that dsh-pet watches:
 *
 *   <dsh-pet config.dir>/agent-events/fishd.jsonl
 *
 * It is deliberately fire-and-forget. A missing folder, a read-only file or
 * a locked desktop pet must never cost the agent a reply.
 */
export function createPetLink(path: string, agent = "fishd"): PetLink {
  let last = "";

  const rotate = () => {
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // missing or locked: append will decide
    }
  };

  return {
    emit(state, tool) {
      const key = `${state}:${tool ?? ""}`;
      if (key === last) return;
      last = key;

      const event = {
        ts: Date.now() / 1000,
        agent,
        state,
        ...(tool ? { tool } : {}),
      };

      try {
        mkdirSync(dirname(path), { recursive: true });
        rotate();
        appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
      } catch {
        // The desktop pet is decoration, never a dependency.
      }
    },
  };
}
