---
name: babylonjs-game-and-animation
description: Comprehensive expert guide for Babylon.js 3D game development, animation groups, skeletal/morph targets, physics (Havok), BabylonJS Editor workflows, shader effects, and performance optimization. Use when building, debugging, or enhancing 3D web games and animations with Babylon.js.
---

# Babylon.js 3D Game Development & Animation Skill

This skill provides patterns, workflows, and best practices for developing 3D web games, interactive scenes, physics simulations, and animations using **Babylon.js** (v6 - v9+), **BabylonJS Editor**, and **Havok Physics**.

---

## 1. Core Architecture & Scene Lifecycle

### Engine and Scene Setup
- Maintain proper lifecycle hooks: initialize engine, create scene, attach render loop, handle resize listeners.
- Enable scene optimizations (e.g. `scene.freezeMaterials()`, `scene.autoClear = false` when full-screen skybox exists).

```typescript
import { Engine, Scene, Vector3, HemisphericLight, ArcRotateCamera } from "@babylonjs/core";

export function createGameScene(canvas: HTMLCanvasElement): { engine: Engine; scene: Scene } {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine);

  const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.5, 10, Vector3.Zero(), scene);
  camera.attachControl(canvas, true);

  const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.8;

  engine.runRenderLoop(() => {
    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });

  return { engine, scene };
}
```

---

## 2. Animation Systems in Babylon.js

### A. Animation Groups (GLTF / Pre-baked Animations)
When loading models (GLTF/GLB) with skeletal or node animations:
```typescript
import { SceneLoader } from "@babylonjs/loaders";

const result = await SceneLoader.ImportMeshAsync("", "/models/", "character.glb", scene);
const idleGroup = scene.getAnimationGroupByName("Idle");
const runGroup = scene.getAnimationGroupByName("Run");

// Cross-fading between animations
function crossFade(fromGroup: AnimationGroup, toGroup: AnimationGroup, duration: number = 0.3) {
  fromGroup.stop();
  toGroup.start(true, 1.0, toGroup.from, toGroup.to, false);
}
```

### B. Procedural / Property Animations
Use `Animation` and `Animatable` for programmatic transformations:
```typescript
import { Animation } from "@babylonjs/core";

export function createBounceAnimation(targetMesh: AbstractMesh) {
  const bounceAnim = new Animation(
    "bounce",
    "position.y",
    60,
    Animation.ANIMATIONTYPE_FLOAT,
    Animation.ANIMATIONLOOPMODE_CYCLE
  );

  const keys = [
    { frame: 0, value: 0 },
    { frame: 30, value: 2 },
    { frame: 60, value: 0 }
  ];
  bounceAnim.setKeys(keys);

  // Easing function for game feel
  const easing = new CircleEase();
  easing.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
  bounceAnim.setEasingFunction(easing);

  targetMesh.animations = [bounceAnim];
  scene.beginAnimation(targetMesh, 0, 60, true);
}
```

### C. Morph Targets & Blendshapes
- Access morph target managers: `mesh.morphTargetManager`.
- Animate facial expressions or deformation weights smoothly using interpolation (`Scalar.Lerp`) inside `scene.onBeforeRenderObservable`.

---

## 3. Physics with Havok (`@babylonjs/havok`)

Always prefer Havok for modern physics stability and high-performance rigid body collision.

```typescript
import HavokPhysics from "@babylonjs/havok";
import { HavokPlugin, PhysicsAggregate, PhysicsShapeType } from "@babylonjs/core";

export async function initPhysics(scene: Scene) {
  const havokInstance = await HavokPhysics();
  const havokPlugin = new HavokPlugin(true, havokInstance);
  scene.enablePhysics(new Vector3(0, -9.81, 0), havokPlugin);

  // Ground plane
  new PhysicsAggregate(groundMesh, PhysicsShapeType.BOX, { mass: 0, restitution: 0.1, friction: 0.8 }, scene);

  // Dynamic entity
  const playerAggregate = new PhysicsAggregate(
    playerMesh,
    PhysicsShapeType.CAPSULE,
    { mass: 70, friction: 0.5, restitution: 0.0 },
    scene
  );

  return havokPlugin;
}
```

---

## 4. BabylonJS Editor Workflows

When working in projects integrated with **BabylonJS Editor** (`babylonjs-editor-tools` & `babylonjs-editor-cli`):
- Custom scripts are attached via export classes implementing `IScript` or editor decorators.
- Scene assets, particle systems, and materials configured in the Editor are loaded using generated scene loaders.
- Run `npm run generate` or `babylonjs-editor-cli pack` after updating workspace assets or editor scenes.

---

## 5. Game Loop, Input & State Management

### Deterministic Game Loop
- Use `scene.onBeforeRenderObservable` or `scene.onAfterRenderObservable` for game mechanics rather than raw `requestAnimationFrame`.
- Calculate `deltaTime = engine.getDeltaTime() / 1000` for frame-rate-independent physics and movement.

### Input Management
- Combine Keyboard/Gamepad event observers:
```typescript
scene.onKeyboardObservable.add((kbInfo) => {
  switch (kbInfo.type) {
    case KeyboardEventTypes.KEYDOWN:
      keysPressed[kbInfo.event.key.toLowerCase()] = true;
      break;
    case KeyboardEventTypes.KEYUP:
      keysPressed[kbInfo.event.key.toLowerCase()] = false;
      break;
  }
});
```

---

## 6. Performance & WebGL / WebGPU Optimization

1. **Draw Calls & Instancing**:
   - Use `ThinInstance` or `createInstance()` for repetitive meshes (bullets, coins, trees, obstacles).
2. **Texture Loading & Compression**:
   - Prefer KTX2 / Basis Universal textures where possible.
3. **Freeze Static Elements**:
   - `mesh.freezeWorldMatrix()` for unmoving terrain and props.
   - `scene.blockMaterialDirtyMechanism = true` during intensive render loops.
4. **Occlusion & Frustum Culling**:
   - Ensure bounding boxes are accurately computed: `mesh.computeWorldMatrix(true)`.
   - Enable `cullingStrategy = AbstractMesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY` for distant objects.
