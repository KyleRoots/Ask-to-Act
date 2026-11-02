import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUserMailboxSession = vi.fn();

vi.mock("./m365-auth.js", () => ({ getUserMailboxSession }));

describe("sendMailViaMicrosoft365 HTML body", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getUserMailboxSession.mockResolvedValue({
      accessToken: "test-access-token",
      mailboxEmail: "recruiter@example.com",
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("escapes HTML in the rendered body, including merged values", async () => {
    const { sendMailViaMicrosoft365 } = await import("./m365-mail.js");
    await sendMailViaMicrosoft365({
      userId: "user-1",
      recipientEmail: "jane@example.com",
      subject: "Hi <b>Jane</b>",
      body: `Hi <img src=x onerror="alert('x')"> & co,\nSecond line`,
    });

    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(payload.message.body).toEqual({
      contentType: "HTML",
      content:
        "Hi &lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; co,<br>Second line",
    });
    expect(payload.message.subject).toBe("Hi <b>Jane</b>");
  });
});
