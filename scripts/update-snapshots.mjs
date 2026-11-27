// Refresh the catalog data bundled into the app (src-tauri/*.snapshot.json) from the catalog's dist branch.
// The app shows this data only until its first successful download (offline first start), so run this
// before every release build: `npm run snapshot`.
import { writeFile } from "node:fs/promises";

const DIST = "https://raw.githubusercontent.com/YangmaoSwitch/catalog/dist";
const FILES = [
  ["catalog.json", "src-tauri/catalog.snapshot.json", (d) => Array.isArray(d.providers) && d.providers.length > 0],
  ["models.json", "src-tauri/models.snapshot.json", (d) => Array.isArray(d.models) && d.models.length > 0],
];

for (const [name, out, ok] of FILES) {
  const r = await fetch(`${DIST}/${name}`, { headers: { "User-Agent": "YangmaoSwitch-app-build" } });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const text = await r.text();
  const data = JSON.parse(text);
  if (!ok(data)) throw new Error(`${name}: unexpected content`);
  await writeFile(out, text);
  console.log(`${out}: generated_at ${data.generated_at ?? "?"}`);
}
