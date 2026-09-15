import { test } from "node:test";
import assert from "node:assert/strict";
import { retentionMatrixScale } from "./retention-matrix-scale.ts";
test("留存率固定全范围，人数按完整查询结果并保留零基线", () => {
  assert.equal(retentionMatrixScale([.2,.4,null],"rate").max,1);
  const count=retentionMatrixScale([0,1200,5000,null],"count");
  assert.equal(count.max,5000); assert.equal(count.intensity(1200),.24);
  assert.equal(count.intensity(null),null); assert.equal(count.intensity(0),0);
});
test("全零、单值与全部未成熟不制造色差",()=>{
  assert.equal(retentionMatrixScale([0,0],"count").intensity(0),0);
  assert.equal(retentionMatrixScale([.3,.3],"rate").single,.3);
  assert.equal(retentionMatrixScale([null,null],"rate").empty,true);
});
