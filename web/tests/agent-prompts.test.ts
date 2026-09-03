import assert from "node:assert/strict";
import test from "node:test";
import { agentConversationPrompts, chooseAgentPrompt } from "../src/agent-prompts";

test("conversation starters explicitly ask the agent to plan and show a route", () => {
  assert.ok(agentConversationPrompts.length >= 5);
  for (const prompt of agentConversationPrompts) {
    assert.match(prompt, /\b(plan|pick|choose)\b/i);
    assert.match(prompt, /\b(show|map)\b/i);
    assert.ok(prompt.length <= 150);
  }
});

test("prompt selection can cover the collection and avoids an immediate repeat", () => {
  assert.equal(chooseAgentPrompt(() => 0), agentConversationPrompts[0]);
  assert.equal(chooseAgentPrompt(() => 0.999), agentConversationPrompts.at(-1));
  assert.notEqual(chooseAgentPrompt(() => 0, agentConversationPrompts[0]), agentConversationPrompts[0]);
});
