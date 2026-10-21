import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const decls = (body: string): Record<string, string> =>
  Object.fromEntries(
    [...body.matchAll(/--dm-([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1] as string,
      (m[2] as string).trim(),
    ]),
  );
const root = decls((/^:root\s*\{([^}]*)\}/m.exec(css) as RegExpExecArray)[1] as string);
const lightOverrides = decls(
  (/:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css) as RegExpExecArray)[1] as string,
);

type Rgb = [number, number, number]; // gamma-encoded sRGB, 0..1
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

function oklch(L: number, C: number, H: number): Rgb {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [gam(clamp(r)), gam(clamp(g)), gam(clamp(bl))];
}

function color(
  value: string,
  vars: Record<string, string>,
  backdrop: Rgb | undefined,
  hue = 0,
): Rgb {
  const v = value.trim().replace(/var\(--h,\s*0\)/g, String(hue));
  const ref = /^var\(--dm-([\w-]+)\)$/.exec(v);
  if (ref) return color(vars[ref[1] as string] as string, vars, backdrop, hue);
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  if (ok) return oklch(Number(ok[1]), Number(ok[2]), Number(ok[3]));
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const p = Number(mix[2]) / 100;
    const a = color(mix[1] as string, vars, backdrop, hue);
    const b =
      (mix[3] as string).trim() === "transparent"
        ? (backdrop as Rgb)
        : color(mix[3] as string, vars, backdrop, hue);
    return [0, 1, 2].map((i) => (a[i] as number) * p + (b[i] as number) * (1 - p)) as Rgb;
  }
  throw new Error(`unparsed colour token: ${v}`);
}
const luminance = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (fg: Rgb, bg: Rgb) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const PAIRS: [fg: string, bg: string][] = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "side"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["muted", "side"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["accent-300", "bg"],
  ["accent-300", "surface"],
  ["accent-100", "accent-800"],
  ["accent-200", "accent-900"],
  ["bg", "accent"],
  ["ok", "ok-bg"],
  ["ok", "bg"],
  ["warn", "bg"],
  ["warn", "surface"],
  ["err", "err-bg"],
  ["err", "bg"],
  ["err", "surface"],
];

describe.each([
  ["dark", root],
  ["light", { ...root, ...lightOverrides }],
] as const)("WCAG AA contrast, %s theme", (_theme, vars) => {
  for (const [fg, bg] of PAIRS) {
    it(`${fg} on ${bg} is at least 4.5:1`, () => {
      const back = color(vars[bg] as string, vars, undefined);
      expect(ratio(color(vars[fg] as string, vars, back), back)).toBeGreaterThanOrEqual(4.5);
    });
  }
  for (const hue of [25, 255, 200, 140, 70, 0]) {
    it(`file-type tile text on its tile, hue ${hue}, is at least 4.5:1`, () => {
      const bg = color(vars["ftype-bg"] as string, vars, undefined, hue);
      expect(ratio(color(vars["ftype-fg"] as string, vars, bg, hue), bg)).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  }
});
