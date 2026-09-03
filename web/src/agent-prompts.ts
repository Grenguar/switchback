export const agentConversationPrompts = Object.freeze([
  "Use Switchback site tools. Plan a relaxed 7 km loop from Vista Rica by car. Show it on the map and check weather and Park alerts.",
  "Use Switchback site tools. I'm hiking with my girlfriend and we're driving. Pick and plan a verified loop, then show it on the map.",
  "Use Switchback site tools. Find a short Collserola walk by public transport. Plan it now and show me the route.",
  "Use Switchback site tools. Surprise me with a verified weekend loop. Plan it now, show it on the map, and check conditions.",
  "Use Switchback site tools. Choose a medium loop by car. Plan it now, show it on the map, and check conditions.",
  "Use Switchback site tools. Pick an afternoon loop by public transport. Plan it now and show it on the map.",
] as const);

/** Picks a fresh conversation starter while avoiding an immediate repeat. */
export function chooseAgentPrompt(random: () => number = Math.random, previous?: string): string {
  const choices = previous === undefined
    ? agentConversationPrompts
    : agentConversationPrompts.filter((prompt) => prompt !== previous);
  const value = random();
  const index = Number.isFinite(value) ? Math.min(choices.length - 1, Math.max(0, Math.floor(value * choices.length))) : 0;
  return choices[index] ?? agentConversationPrompts[0];
}
