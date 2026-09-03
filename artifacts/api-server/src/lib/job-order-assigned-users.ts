/**
 * Bullhorn JobOrder Recruiter(s) (`assignedUsers`) writes.
 *
 * Standard entity POST/PUT cannot persist this to-many field — Bullhorn requires
 * the association endpoint (PUT to add, DELETE to remove) or an `{ add, remove }`
 * wrapper on POST. We strip `assignedUsers` from generic write bodies and apply
 * via association calls (same pattern as Task secondaryOwners / Tearsheet membership).
 */

export type AssignedUsersWriteSession = {
  BhRestToken: string;
  restUrl: string;
};

export type AssignedUsersWrite = {
  add: number[];
  remove: number[];
};

export type AssignedUsersWriteFetch = (
  session: AssignedUsersWriteSession,
  method: "PUT" | "POST" | "DELETE",
  path: string,
  body: unknown,
) => Promise<unknown>;

function parseIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0) {
      ids.push(item);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "number" && Number.isInteger(id) && id > 0) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/** Parse MCP/Bullhorn assignedUsers payloads into add/remove id lists. */
export function parseAssignedUsersWrite(value: unknown): AssignedUsersWrite | null {
  if (value === undefined || value === null) return null;

  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ("add" in obj || "remove" in obj) {
      const add = parseIdList(obj.add);
      const remove = parseIdList(obj.remove);
      if (add.length === 0 && remove.length === 0) return null;
      return { add, remove };
    }
  }

  if (Array.isArray(value)) {
    const add = parseIdList(value);
    if (add.length === 0) return null;
    return { add, remove: [] };
  }

  return null;
}

/** Remove assignedUsers from a write body and return the parsed association write. */
export function stripAssignedUsersFromFields(fields: Record<string, unknown>): {
  fields: Record<string, unknown>;
  assignedUsers: AssignedUsersWrite | null;
} {
  const key = Object.keys(fields).find((k) => k.toLowerCase() === "assignedusers");
  if (!key) return { fields, assignedUsers: null };
  const { [key]: raw, ...rest } = fields;
  return { fields: rest, assignedUsers: parseAssignedUsersWrite(raw) };
}

export async function applyJobOrderAssignedUsers(
  session: AssignedUsersWriteSession,
  jobOrderId: number,
  write: AssignedUsersWrite,
  writeFetch: AssignedUsersWriteFetch,
): Promise<{ added: number[]; removed: number[] }> {
  let added: number[] = [];
  let removed: number[] = [];

  if (write.remove.length > 0) {
    await writeFetch(
      session,
      "DELETE",
      `entity/JobOrder/${jobOrderId}/assignedUsers/${write.remove.join(",")}`,
      undefined,
    );
    removed = write.remove;
  }

  if (write.add.length > 0) {
    await writeFetch(
      session,
      "PUT",
      `entity/JobOrder/${jobOrderId}/assignedUsers/${write.add.join(",")}`,
      undefined,
    );
    added = write.add;
  }

  return { added, removed };
}
