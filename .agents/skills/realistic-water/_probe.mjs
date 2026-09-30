export default async function run(page, ui) {
  // Wait for the app to actually hydrate, not just for load.
  await page.waitForFunction(() => !!window.__hs, null, { timeout: 120000 });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => {
    const hs = window.__hs;
    const s = hs.scene;
    const sea = s.meshes.find(m => m.name === "sea");
    const mat = s.getMaterialByName("oceanMat");
    return {
      clutter: hs.clutterStats(),
      meshes: s.meshes.length,
      transforms: s.transformNodes.length,
      camY: hs.camera.position.y,
      seaReady: mat ? mat.isReady(sea) : "noMat",
      seaPos: sea ? [sea.position.x, sea.position.y, sea.position.z] : null,
      shipY: (() => { const n = s.transformNodes.find(t => /^ship_s\d+$/.test(t.name)); return n ? [n.position.x, n.position.y, n.position.z] : null; })(),
    };
  });
  return r;
}
