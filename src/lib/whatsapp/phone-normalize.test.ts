import { describe, expect, it } from "vitest";
import { fixDoubledCountryCode, toInternationalPhone } from "./phone-utils";

describe("fixDoubledCountryCode", () => {
  it("repairs an Indian number with +91 typed twice (broadcast #131026)", () => {
    expect(fixDoubledCountryCode("+91919174824860")).toBe("919174824860");
  });

  it("leaves correct numbers alone", () => {
    expect(fixDoubledCountryCode("919174824860")).toBeNull();
    expect(fixDoubledCountryCode("14155551212")).toBeNull();
    expect(fixDoubledCountryCode("37063949836")).toBeNull();
  });
});

describe("toInternationalPhone", () => {
  it.each([
    ["+91 98765 43210", "91", "+919876543210"],
    ["0091 9876543210", "91", "+919876543210"],
    ["09876543210", "91", "+919876543210"],
    ["9876543210", "91", "+919876543210"],
    ["919876543210", "+91", "+919876543210"],
    ["+91919876543210", "91", "+919876543210"],
    ["919876543210.0", "91", "+919876543210"],
    ["4155551212", "1", "+14155551212"],
  ])("%s with cc %s → %s", (raw, cc, expected) => {
    expect(toInternationalPhone(raw, cc)).toBe(expected);
  });

  it("rejects unusable input", () => {
    expect(toInternationalPhone("", "91")).toBeNull();
    expect(toInternationalPhone("9.19876E+11", "91")).toBeNull();
    expect(toInternationalPhone("9876543210", "")).toBeNull();
    expect(toInternationalPhone("abc", "91")).toBeNull();
  });
});
