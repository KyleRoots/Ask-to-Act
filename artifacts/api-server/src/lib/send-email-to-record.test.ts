import { beforeEach, describe, expect, it, vi } from "vitest";

const getCandidate = vi.fn();
const getContact = vi.fn();
const addNote = vi.fn();
const getUserMailboxStatus = vi.fn();
const getMailboxConnectUrlForUser = vi.fn();
class MailboxNotConnectedError extends Error {
  constructor(public readonly connectUrl: string) {
    super("not connected");
  }
}
class MailboxReconnectRequiredError extends Error {
  constructor(public readonly connectUrl: string) {
    super("reconnect");
  }
}

vi.mock("./bullhorn-client.js", () => ({
  addNote,
  getCandidate,
  getContact,
}));

vi.mock("./m365-auth.js", () => ({
  MailboxNotConnectedError,
  MailboxReconnectRequiredError,
  getUserMailboxStatus,
  getMailboxConnectUrlForUser,
}));

vi.mock("@workspace/db", () => ({
  db: {},
  usersTable: {
    id: "id",
    name: "name",
    email: "email",
  },
}));

describe("previewEmailToRecord", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("blocks sends when the Bullhorn record has no email", async () => {
    getCandidate.mockResolvedValue({
      data: { id: 101, firstName: "Jane", lastName: "Doe", email: "", status: "Active" },
    });

    const { previewEmailToRecord } = await import("./send-email-to-record.js");
    const result = await previewEmailToRecord({
      userId: "user-1",
      entityType: "Candidate",
      recordId: 101,
      subject: "Hello",
      body: "Body",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "missing_email",
    });
  });

  it("blocks sends when a candidate status contains DNC / opted-out markers", async () => {
    getCandidate.mockResolvedValue({
      data: {
        id: 202,
        firstName: "Victor",
        lastName: "Ng",
        email: "victor@example.com",
        status: "Do Not Contact - Opted Out",
      },
    });

    const { previewEmailToRecord } = await import("./send-email-to-record.js");
    const result = await previewEmailToRecord({
      userId: "user-1",
      entityType: "Candidate",
      recordId: 202,
      subject: "Hello",
      body: "Body",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "do_not_contact",
    });
  });

  it("returns a connectUrl when the mailbox is not connected yet", async () => {
    getContact.mockResolvedValue({
      data: {
        id: 303,
        firstName: "Alex",
        lastName: "Kim",
        email: "alex@example.com",
        status: "Active",
        bullhornUrl: "https://bullhorn.example/contact/303",
      },
    });
    getUserMailboxStatus.mockResolvedValue({
      connected: false,
      mailboxEmail: null,
    });
    getMailboxConnectUrlForUser.mockResolvedValue(
      "https://connect.asktoact.ai/api/auth/m365/start?token=test",
    );

    const { previewEmailToRecord } = await import("./send-email-to-record.js");
    const result = await previewEmailToRecord({
      userId: "user-1",
      entityType: "ClientContact",
      recordId: 303,
      subject: "Hello",
      body: "Body",
    });

    expect(result).toMatchObject({
      ok: true,
      mailboxConnected: false,
      connectUrl: "https://connect.asktoact.ai/api/auth/m365/start?token=test",
      recipient: {
        recordId: 303,
        email: "alex@example.com",
      },
    });
  });
});
