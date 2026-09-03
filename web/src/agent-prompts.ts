export const agentConversationPrompts = Object.freeze([
  "Plan a relaxed 7 km loop from Vista Rica by car. Show it on the map and check the weather and Park alerts.",
  "I'm going hiking with my girlfriend and we're driving. Pick a verified loop, plan it now, and show it on the map.",
  "Find me a short Collserola walk I can reach by public transport. Plan it now and show me the route.",
  "Surprise me with a verified Collserola loop for this weekend. Plan it now, show it on the map, and tell me what to check before I go.",
  "I want a medium-length walk by car. Choose a verified start, plan the loop now, show it on the map, and check conditions.",
  "I have an afternoon free and want to hike by public transport. Pick a verified loop, plan it now, and show it on the map.",
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
