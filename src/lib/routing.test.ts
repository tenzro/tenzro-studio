import { describe, it, expect } from "vitest";
import { pickProvider, type ModelEndpoint } from "./routing";

const ep = (over: Partial<ModelEndpoint>): ModelEndpoint => ({
  instance_id: over.instance_id ?? "i",
  model_id: over.model_id ?? "m",
  ...over,
});

describe("pickProvider", () => {
  it("returns null for an empty list", () => {
    expect(pickProvider([])).toBeNull();
  });

  it("returns the only endpoint when there is one", () => {
    const only = ep({ instance_id: "solo" });
    expect(pickProvider([only])).toBe(only);
  });

  it("prefers Online over Offline/Degraded", () => {
    const offline = ep({ instance_id: "off", status: "Offline" });
    const online = ep({ instance_id: "on", status: "Online" });
    const degraded = ep({ instance_id: "deg", status: "Degraded" });
    expect(pickProvider([offline, degraded, online])?.instance_id).toBe("on");
  });

  it("falls back to an unhealthy endpoint when none are Online", () => {
    const offline = ep({ instance_id: "off", status: "Offline" });
    const degraded = ep({ instance_id: "deg", status: "Degraded" });
    // Picks one of them rather than null.
    expect(pickProvider([offline, degraded])).not.toBeNull();
  });

  it("treats a missing status as healthy", () => {
    const noStatus = ep({ instance_id: "legacy" });
    const offline = ep({ instance_id: "off", status: "Offline" });
    expect(pickProvider([offline, noStatus])?.instance_id).toBe("legacy");
  });

  it("picks the least-loaded healthy endpoint", () => {
    const busy = ep({
      instance_id: "busy",
      status: "Online",
      load: { utilization_percent: 90 },
    });
    const idle = ep({
      instance_id: "idle",
      status: "Online",
      load: { utilization_percent: 10 },
    });
    expect(pickProvider([busy, idle])?.instance_id).toBe("idle");
  });

  it("prefers an endpoint reporting load over one with unknown load", () => {
    const known = ep({
      instance_id: "known",
      status: "Online",
      load: { utilization_percent: 50 },
    });
    const unknown = ep({ instance_id: "unknown", status: "Online" });
    expect(pickProvider([unknown, known])?.instance_id).toBe("known");
  });

  it("breaks ties on output price", () => {
    const pricey = ep({
      instance_id: "pricey",
      status: "Online",
      load: { utilization_percent: 20 },
      pricing: { output: 100 },
    });
    const cheap = ep({
      instance_id: "cheap",
      status: "Online",
      load: { utilization_percent: 20 },
      pricing: { output: 5 },
    });
    expect(pickProvider([pricey, cheap])?.instance_id).toBe("cheap");
  });

  it("falls back to input price when output is absent for the tie-break", () => {
    const a = ep({
      instance_id: "a",
      status: "Online",
      load: { utilization_percent: 0 },
      pricing: { input: 9 },
    });
    const b = ep({
      instance_id: "b",
      status: "Online",
      load: { utilization_percent: 0 },
      pricing: { input: 2 },
    });
    expect(pickProvider([a, b])?.instance_id).toBe("b");
  });
});
