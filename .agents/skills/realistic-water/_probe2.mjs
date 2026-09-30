export default async function run(page) {
  // Poll until the handle exists, then read everything in the SAME evaluate so a
  // dev-server reload cannot wipe it between the wait and the read.
  const r = await page.waitForFunction(() => {
    const hs = window.__hs;
    if (!hs) return null;
    const s = hs.scene;
    const sea = s.meshes.find(m => m.name === "sea");
    const mat = s.getMaterialByName("oceanMat");
    const ship = s.transformNodes.find(t => /^ship_s\d+$/.test(t.name));
    return {
      clutter: hs.clutterStats(),
      meshes: s.meshes.length,
      transforms: s.transformNodes.length,
      camY: Math.round(hs.camera.position.y * 100) / 100,
      seaReady: mat ? mat.isReady(sea) : "noMat",
      seaPos: sea ? [sea.position.x, sea.position.y, sea.position.z] : null,
      shipPos: ship ? [Math.round(ship.position.x*100)/100, Math.round(ship.position.y*100)/100, Math.round(ship.position.z*100)/100] : null,
      selfId: hs.net.selfShipId,
    };
  }, null, { timeout: 150000, polling: 500 });
  return await r.jsonValue();
}
