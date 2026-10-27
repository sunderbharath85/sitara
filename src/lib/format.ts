// `taken` values are wall-clock seconds stored as if UTC, so every formatter pins timeZone to UTC.
const UTC = { timeZone: "UTC" } as const;

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const fmtMonth = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { ...UTC, month: "long", year: "numeric" });
export const fmtDay = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-US", { ...UTC, weekday: "short", month: "short", day: "numeric", year: "numeric" });
export const fmtShortDay = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { ...UTC, month: "short", day: "numeric", year: "numeric" });
export const fmtTime = (t: number) => new Date(t * 1000).toLocaleTimeString("en-US", { ...UTC, hour: "numeric", minute: "2-digit" });
export const weekday = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { ...UTC, weekday: "long" });
export const hourOf = (t: number) => new Date(t * 1000).getUTCHours();

export const dayPart = (h: number) =>
  h < 5 ? "night" : h < 9 ? "early morning" : h < 12 ? "morning" : h < 16 ? "afternoon" : h < 18 ? "golden hour" : h < 20 ? "evening" : "night";

export function fmtSize(bytes: number) {
  if (bytes <= 0) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
export const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const fmtNum = (n: number) => n.toLocaleString("en-US");
export const plural = (n: number, one: string, many = one + "s") => `${fmtNum(n)} ${n === 1 ? one : many}`;

export function ago(ms: number | null) {
  if (!ms) return "never";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function camera(make: string | null, model: string | null) {
  if (!model) return make ?? "";
  if (!make) return model;
  const brand = make.split(/\s+/)[0].toLowerCase();
  // "Canon" + "Canon EOS R5" → "Canon EOS R5"; "SONY" + "ILCE-7M4" → "Sony ILCE-7M4"
  if (model.toLowerCase().startsWith(brand)) return model;
  const nice = make.length <= 5 && make === make.toUpperCase() ? make[0] + make.slice(1).toLowerCase() : make.replace(/ CORPORATION| Corporation|,? Inc\.?/g, "");
  return `${nice} ${model}`;
}

export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
