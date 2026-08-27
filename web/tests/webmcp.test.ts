import assert from "node:assert/strict";
import test from "node:test";
import { activeRouteToolContracts } from "../src/tools";
import { registerWebMcpTools } from "../src/webmcp";

type ModelContext = {
  registerTool?: (tool: { name: string }, options?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
};

function withModelContexts(documentContext: ModelContext | undefined, navigatorContext: ModelContext | undefined): () => void {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentContext ? { modelContext: documentContext } : {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigatorContext ? { modelContext: navigatorContext } : {} });
  return () => {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: unknown }).document;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  };
}

test("WebMCP diagnostics report unavailable when the browser exposes no model context", async () => {
  const restore = withModelContexts(undefined, undefined);
  try {
    const result = await registerWebMcpTools(true);
    assert.deepEqual(result, {
      status: "unavailable",
      count: 0,
      message: "Model context not exposed by this browser.",
    });
  } finally {
    restore();
  }
});

test("WebMCP diagnostics report every active tool when registration succeeds", async () => {
  const registered: string[] = [];
  const restore = withModelContexts({
    registerTool: (tool, options) => {
      assert.ok(options?.signal);
      assert.equal(options?.signal.aborted, false);
      registered.push(tool.name);
    },
  }, undefined);
  try {
    const result = await registerWebMcpTools(true);
    assert.deepEqual(registered, activeRouteToolContracts.map((tool) => tool.name));
    assert.deepEqual(result, {
      status: "registered",
      count: activeRouteToolContracts.length,
      message: `${activeRouteToolContracts.length} tools registered with the browser model context.`,
    });
  } finally {
    restore();
  }
});

test("WebMCP diagnostics retain the successful count and error when registration fails", async () => {
  let attempted = 0;
  const restore = withModelContexts({
    registerTool: (tool) => {
      attempted += 1;
      if (tool.name === activeRouteToolContracts[2]?.name) throw new Error("browser denied tool registration");
    },
  }, undefined);
  try {
    const result = await registerWebMcpTools(true);
    assert.equal(attempted, 3);
    assert.deepEqual(result, {
      status: "failed",
      count: 2,
      message: "browser denied tool registration",
    });
  } finally {
    restore();
  }
});
