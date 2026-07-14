import { describe, expect, it } from "vitest";

import { weatherForBucket } from "../src/hud/day-chip-weather.js";

describe("weatherForBucket", () => {
  it("returns the same weather for the same time bucket", () => {
    expect(weatherForBucket(5_948_321)).toEqual(weatherForBucket(5_948_321));
  });

  it("deterministically varies the weather across time buckets", () => {
    const firstPass = Array.from({ length: 24 }, (_, bucket) =>
      weatherForBucket(bucket),
    );
    const secondPass = Array.from({ length: 24 }, (_, bucket) =>
      weatherForBucket(bucket),
    );

    expect(secondPass).toEqual(firstPass);
    expect(new Set(firstPass.map((weather) => weather.condition)).size).toBeGreaterThan(
      1,
    );
  });
});
