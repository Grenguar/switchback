import assert from "node:assert/strict";
import test from "node:test";
import { toolContracts } from "../src/tools";

test("all five tool contracts are present and have strict object schemas", () => {
  assert.equal(toolContracts.length, 5);
  assert.deepEqual(toolContracts.map((tool) => tool.name), ["plan_route", "get_route_summary", "explain_segment", "avoid_segment", "describe_last_edit"]);
  for (const tool of toolContracts) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.untrustedContentHint, true);
  }
  assert.equal(toolContracts.find((tool) => tool.name === "plan_route")?.annotations.readOnlyHint, false);
  for (const name of ["get_route_summary", "explain_segment", "describe_last_edit"]) assert.equal(toolContracts.find((tool) => tool.name === name)?.annotations.readOnlyHint, true);
});

test("plan_route validates its raw distance constraint and returns a bounded result", async () => {
  const tool = toolContracts.find((candidate) => candidate.name === "plan_route");
  assert.ok(tool);
  await assert.rejects(() => tool.execute({ target_km: 61, prefer_waymarked: true }), /no greater than/);
  await assert.rejects(() => tool.execute({ target_km: 15, prefer_waymarked: true, unsupported: true }), /Unexpected/);
  const result = await tool.execute({ target_km: 15, prefer_waymarked: true });
  assert.ok(JSON.stringify(result).length <= 1_500);
});
