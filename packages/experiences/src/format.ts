const UNITS = ["B", "KB", "MB", "GB"];
/** "0 B", "512 B", "1.5 KB": one decimal from 1 KB. */
export function formatBytes(n: number): string {
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${UNITS[u]}`;
}
