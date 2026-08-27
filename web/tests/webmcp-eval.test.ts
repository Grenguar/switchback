import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { activeRouteToolContracts } from "../src/tools";

type WebMcpFixture = {
  required_core_tools: string[];
  required_contract_properties: {
    input_schema_type: string;
    additional_properties: boolean;
    untrusted_content_hint: boolean;
  };
};

test("WebMCP evaluation fixture matches the active six-tool contract", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../evals/webmcp-tool-contract.json", import.meta.url), "utf8")) as WebMcpFixture;
  assert.deepEqual(activeRouteToolContracts.map((tool) => tool.name), fixture.required_core_tools);
  for (const tool of activeRouteToolContracts) {
    assert.equal(tool.inputSchema.type, fixture.required_contract_properties.input_schema_type, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, fixture.required_contract_properties.additional_properties, tool.name);
    assert.equal(tool.annotations.untrustedContentHint, fixture.required_contract_properties.untrusted_content_hint, tool.name);
  }
});
