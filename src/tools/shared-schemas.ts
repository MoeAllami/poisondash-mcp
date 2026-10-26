import { z } from "zod";

/** cpu | cuda | cuda:N -- validated server-side with the same regex. */
export const deviceRegex = /^(cpu|cuda|cuda:\d+)$/;

export function deviceField(defaultValue: "cpu") {
  return z.string().regex(deviceRegex, "must be cpu, cuda, or cuda:N").default(defaultValue);
}

export function optionalDeviceField() {
  return z.string().regex(deviceRegex, "must be cpu, cuda, or cuda:N").optional();
}
