// Roster → engine bridge.
//
// The roster lives in @ares/agent (it owns ~/.ares) and the subagent registry
// lives in @ares/core (it owns the turn loop). Neither package depends on the
// other, and adding that edge just to share a type would couple the mind layer
// to the engine. The CLI depends on both, so the adaptation belongs here.
//
// The payoff: a persona is authored ONCE as markdown, and this file makes it
// simultaneously delegable (a real `subagent_type` for the Task tool and for
// Conductor fleets) and adoptable (a prompt layer for the live session).

import { renderPersonaLayer, type PersonaDef } from "@ares/agent";
import { SubagentRegistry, type SubagentTypeDef } from "@ares/core";

/**
 * Adapt one persona into a subagent type.
 *
 * Note the asymmetry with adoption, which is deliberate: when DELEGATED, the
 * persona's `tools` list becomes a hard whitelist, because a child with a
 * narrow belt is the entire point of delegation (a researcher that cannot
 * write can't quietly "fix" what it was asked to inspect). When ADOPTED, the
 * live belt is untouched — see the Persona tool's header.
 */
export function personaAsSubagentType(persona: PersonaDef): SubagentTypeDef {
  return {
    name: persona.name,
    description: `${persona.description} (persona${persona.source === "builtin" ? "" : " · authored on disk"})`,
    // Empty list means "inherit everything" on the roster side; the engine
    // expects `undefined` for that, and an empty array would hand the child a
    // belt of zero tools.
    toolWhitelist: persona.tools.length > 0 ? persona.tools : undefined,
    systemPrompt: renderPersonaLayer(persona),
    maxTurns: persona.maxTurns,
  };
}

/**
 * Register every persona as a delegable subagent type.
 *
 * Personas are applied AFTER the built-ins so a persona named `verifier` or
 * `explorer` deliberately overrides the built-in of that name — same override
 * rule the roster already uses for disk-over-builtin, so there is exactly one
 * mental model: the more specific definition wins.
 *
 * Returns the names registered, for logging.
 */
export function registerPersonaSubagents(
  registry: SubagentRegistry,
  personas: readonly PersonaDef[],
): string[] {
  const names: string[] = [];
  for (const persona of personas) {
    registry.register(personaAsSubagentType(persona));
    names.push(persona.name);
  }
  return names;
}
