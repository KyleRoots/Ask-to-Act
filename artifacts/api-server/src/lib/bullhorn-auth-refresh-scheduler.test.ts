import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runProactiveBullhornAuthRefresh = vi.hoisted(() => vi.fn());

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./bullhorn-auth-refresh.js", () => ({
  runProactiveBullhornAuthRefresh,
}));

import {
  startBullhornAuthRefreshScheduler,
  stopBullhornAuthRefreshScheduler,
} from "./bullhorn-auth-refresh-scheduler.js";

const BOOT_DELAY_MS = 3 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;

const okResult = {
  firmsAttempted: 0,
  firmsOk: 0,
  firmsFailed: 0,
  usersAttempted: 0,
  usersOk: 0,
  usersFailed: 0,
};

const originalRefresh = process.env["BULLHORN_AUTH_REFRESH"];
const originalInterval = process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"];

function restoreEnv(): void {
  if (originalRefresh === undefined) delete process.env["BULLHORN_AUTH_REFRESH"];
  else process.env["BULLHORN_AUTH_REFRESH"] = originalRefresh;
  if (originalInterval === undefined) delete process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"];
  else process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"] = originalInterval;
}

beforeEach(() => {
  vi.useFakeTimers();
  runProactiveBullhornAuthRefresh.mockReset();
  runProactiveBullhornAuthRefresh.mockResolvedValue(okResult);
  delete process.env["BULLHORN_AUTH_REFRESH"];
  delete process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"];
});

afterEach(() => {
  stopBullhornAuthRefreshScheduler();
  vi.useRealTimers();
  restoreEnv();
});

describe("Bullhorn auth refresh scheduler", () => {
  it("does not schedule work when proactive refresh is disabled", async () => {
    process.env["BULLHORN_AUTH_REFRESH"] = "0";
    startBullhornAuthRefreshScheduler();

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 2);
    expect(runProactiveBullhornAuthRefresh).not.toHaveBeenCalled();
  });

  it("floors a too-small interval so a bad env cannot hammer Bullhorn", async () => {
    process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"] = String(MIN_INTERVAL_MS - 1);
    startBullhornAuthRefreshScheduler();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS - 1);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(2);
  });

  it("accepts the five-minute floor and ignores blank or non-numeric intervals", async () => {
    process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"] = String(MIN_INTERVAL_MS);
    startBullhornAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS + MIN_INTERVAL_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(2);
    stopBullhornAuthRefreshScheduler();
    runProactiveBullhornAuthRefresh.mockClear();

    process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"] = "   ";
    startBullhornAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS + DEFAULT_INTERVAL_MS - 1);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(1);
    stopBullhornAuthRefreshScheduler();
    runProactiveBullhornAuthRefresh.mockClear();

    process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"] = "nope";
    startBullhornAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS + DEFAULT_INTERVAL_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(2);
  });

  it("skips an overlapping tick and runs again once the in-flight refresh finishes", async () => {
    process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"] = String(MIN_INTERVAL_MS);
    let release: (() => void) | undefined;
    runProactiveBullhornAuthRefresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(okResult);
        }),
    );

    startBullhornAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(2);
  });

  it("keeps scheduling after a tick throws", async () => {
    process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"] = String(MIN_INTERVAL_MS);
    runProactiveBullhornAuthRefresh
      .mockRejectedValueOnce(new Error("temporary bullhorn outage"))
      .mockResolvedValue(okResult);

    startBullhornAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(2);
  });

  it("starts once and stop cancels the boot delay and later ticks", async () => {
    process.env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"] = String(MIN_INTERVAL_MS);
    startBullhornAuthRefreshScheduler();
    startBullhornAuthRefreshScheduler();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS + MIN_INTERVAL_MS);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(2);

    stopBullhornAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS * 3);
    expect(runProactiveBullhornAuthRefresh).toHaveBeenCalledTimes(2);

    runProactiveBullhornAuthRefresh.mockClear();
    startBullhornAuthRefreshScheduler();
    stopBullhornAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS + DEFAULT_INTERVAL_MS);
    expect(runProactiveBullhornAuthRefresh).not.toHaveBeenCalled();
  });
});
