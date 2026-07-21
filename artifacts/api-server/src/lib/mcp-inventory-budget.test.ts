import { describe, it, expect } from "vitest";
import {
  createMcpServer,
  MCP_TOOL_PRIORITY,
  MCP_DESCRIPTION_BUDGET_CHARS,
} from "./mcp-server.js";

type RegEntry = {
  description?: string;
  annotations?: Record<string, unknown>;
};

function registeredTools(): Record<string, RegEntry> {
  const server = createMcpServer({
    kind: "user",
    userId: "test-user",
    firmId: "test-firm",
  });
  const reg = (
    server as unknown as { _registeredTools?: Record<string, RegEntry> }
  )._registeredTools;
  if (!reg) throw new Error("Could not access MCP server tool registry");
  return reg;
}

describe("MCP universal inventory hardening", () => {
  it("registers the full universal tool set including reads and writes", () => {
    const reg = registeredTools();
    const names = Object.keys(reg);
    expect(names.length).toBeGreaterThanOrEqual(65);
    expect(reg["scout_dept_report"]).toBeDefined();
    expect(reg["list_reports"]).toBeDefined();
    expect(reg["add_note"]).toBeDefined();
    expect(reg["update_candidate"]).toBeDefined();
    expect(reg["create_job"]).toBeDefined();
    expect(reg["delete_entity"]).toBeDefined();
    expect(reg["search_candidates"]?.annotations?.readOnlyHint).toBe(true);
    expect(reg["add_note"]?.annotations?.readOnlyHint).toBe(false);
  });

  it("registers high-value tools before lower-priority ones", () => {
    const reg = registeredTools();
    const names = Object.keys(reg);
    const idx = (n: string) => {
      const i = names.indexOf(n);
      expect(i, `missing tool ${n}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(idx("list_reports")).toBeLessThan(idx("scout_dept_report"));
    expect(idx("scout_dept_report")).toBeLessThan(idx("search_entity"));
    expect(idx("scout_dept_report")).toBeLessThan(idx("add_note"));
    expect(idx("add_note")).toBeLessThan(idx("delete_entity"));
    // Priority list should cover every registered tool (no silent orphans).
    for (const name of names) {
      expect(MCP_TOOL_PRIORITY.includes(name), `add ${name} to MCP_TOOL_PRIORITY`).toBe(
        true,
      );
    }
  });

  it("keeps total tool description size under the ChatGPT budget", () => {
    const reg = registeredTools();
    let total = 0;
    for (const entry of Object.values(reg)) {
      total += (entry.description ?? "").length;
    }
    expect(total).toBeLessThanOrEqual(MCP_DESCRIPTION_BUDGET_CHARS);
    // Sanity: budget itself should stay meaningful (not accidentally 0).
    expect(total).toBeGreaterThan(10_000);
  });
});
