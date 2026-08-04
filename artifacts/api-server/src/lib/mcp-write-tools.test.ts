import { describe, it, expect } from "vitest";
import { createMcpServer } from "./mcp-server.js";

// ---------------------------------------------------------------------------
// Write-back surface wiring (Task 50).
//
// These tests assert the STRUCTURE of the MCP write surface — that every new
// write tool is registered with correct write annotations, and that none of
// them leak into the public, unauthenticated OpenAPI door (writes are MCP-
// connector only). They do not perform any live Bullhorn writes.
// ---------------------------------------------------------------------------

const NEW_WRITE_TOOLS = [
  "update_submission_status",
  "create_job",
  "update_job",
  "create_company",
  "update_company",
  "create_contact",
  "update_contact",
  "create_task",
  "create_appointment",
  "create_tearsheet",
  "add_candidates_to_tearsheet",
  "remove_candidates_from_tearsheet",
  "create_placement",
  "update_placement",
  "upload_file_to_record",
  "create_candidate_from_resume",
  "send_email_to_record",
  "send_email_to_records",
];

// Destructive tools (soft-delete surface) must additionally carry
// destructiveHint:true so MCP clients can gate them behind explicit approval.
const DESTRUCTIVE_TOOLS = ["delete_entity", "restore_entity", "archive_placement"];

function registeredTools(): Record<string, { annotations?: Record<string, unknown> }> {
  const server = createMcpServer({ kind: "user", userId: "test-user", firmId: "test-firm" });
  const reg = (server as unknown as { _registeredTools?: Record<string, { annotations?: Record<string, unknown> }> })
    ._registeredTools;
  if (!reg) throw new Error("Could not access MCP server tool registry (_registeredTools)");
  return reg;
}

describe("MCP write-back surface", () => {
  it("registers every new write tool", () => {
    const reg = registeredTools();
    for (const name of NEW_WRITE_TOOLS) {
      expect(reg[name], `expected write tool "${name}" to be registered`).toBeDefined();
    }
  });

  it("marks every new write tool with write annotations (readOnlyHint:false)", () => {
    const reg = registeredTools();
    for (const name of NEW_WRITE_TOOLS) {
      const ann = reg[name]?.annotations ?? {};
      expect(ann.readOnlyHint, `${name} must NOT be readOnly`).toBe(false);
      expect(ann.openWorldHint, `${name} must declare openWorldHint:false`).toBe(false);
    }
  });

  it("keeps existing read tools read-only (no accidental annotation flip)", () => {
    const reg = registeredTools();
    expect(reg["search_candidates"]?.annotations?.readOnlyHint).toBe(true);
    expect(reg["count_entity"]?.annotations?.readOnlyHint).toBe(true);
  });

  it("registers every destructive tool with destructiveHint:true", () => {
    const reg = registeredTools();
    for (const name of DESTRUCTIVE_TOOLS) {
      const ann = reg[name]?.annotations ?? {};
      expect(reg[name], `expected destructive tool "${name}" to be registered`).toBeDefined();
      expect(ann.readOnlyHint, `${name} must NOT be readOnly`).toBe(false);
      expect(ann.destructiveHint, `${name} must declare destructiveHint:true`).toBe(true);
      expect(ann.openWorldHint, `${name} must declare openWorldHint:false`).toBe(false);
    }
  });

  it("keeps non-destructive write tools at destructiveHint:false", () => {
    const reg = registeredTools();
    for (const name of NEW_WRITE_TOOLS) {
      expect(
        reg[name]?.annotations?.destructiveHint,
        `${name} must NOT be flagged destructive`,
      ).toBe(false);
    }
  });
});

describe("public OpenAPI door stays read-only", () => {
  it("does not expose any write tool in the Custom GPT Actions spec", async () => {
    // Assert against the same function the public /api/openapi.json route serves
    // (avoids full-app Clerk middleware in unit tests).
    const { actionsSpec } = await import("../routes/openapi.js");
    const body = actionsSpec("https://example.test");

    const doc = JSON.stringify(body).toLowerCase();
    // No write operation ids / paths should appear in the public schema.
    for (const name of [...NEW_WRITE_TOOLS, ...DESTRUCTIVE_TOOLS]) {
      expect(doc.includes(name)).toBe(false);
    }
    // Every declared path must be a read-only reporting op:
    // GET reports, POST /count, or POST async scout job start (no Bullhorn writes).
    const paths = body.paths as Record<string, Record<string, unknown>>;
    for (const [path, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods)) {
        const isReadOnly =
          method === "get" ||
          (method === "post" && path === "/count") ||
          (method === "post" &&
            path === "/reports/scout-qualified-by-department/jobs");
        expect(
          isReadOnly,
          `public path ${method.toUpperCase()} ${path} must be read-only`,
        ).toBe(true);
      }
    }
    expect(paths["/reports/scout-qualified-by-department/jobs"]?.post).toBeDefined();
    expect(paths["/reports/jobs/{jobId}"]?.get).toBeDefined();
    const scoutDesc = String(
      (paths["/reports/scout-qualified-by-department"]?.get as { description?: string })
        ?.description ?? "",
    );
    expect(scoutDesc).toMatch(/asyncContinuation/i);
    expect(scoutDesc).toMatch(/wall_time/);
    expect(scoutDesc).toMatch(/\/reports\/scout-qualified-by-department\/jobs/);
    expect(scoutDesc).toMatch(/\/reports\/jobs\/\{jobId\}/);
    const startDesc = String(
      (
        paths["/reports/scout-qualified-by-department/jobs"]?.post as {
          description?: string;
        }
      )?.description ?? "",
    );
    expect(startDesc).toMatch(/soft-wall|wall_time/i);
    expect(startDesc).toMatch(/date-window fan-out/i);
    expect(String(body.servers?.[0]?.url ?? "")).toMatch(/\/api\/v1$/);
  });
});
