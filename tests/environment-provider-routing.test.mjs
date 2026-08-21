import assert from "node:assert/strict";
import test from "node:test";

import { manifestPatternMatches } from "../packages/cli/dist/entry/sessionFactory.js";

test("environment-provider manifest matchers route arbitrary files and commands", () => {
  assert.equal(manifestPatternMatches("*.blend", "D:/art/hero.blend"), true);
  assert.equal(manifestPatternMatches("**/scenes/*.scene", "D:/game/content/scenes/weapon.scene"), true);
  assert.equal(manifestPatternMatches("project.custom", "D:/future-engine/project.custom"), true);
  assert.equal(manifestPatternMatches("future-editor", "future-editor --project D:/game"), true);
  assert.equal(manifestPatternMatches("*.blend", "D:/art/hero.fbx"), false);
});
