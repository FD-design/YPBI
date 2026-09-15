import {test} from "node:test";
import assert from "node:assert/strict";
import {compositionStatus} from "./composition-model.ts";
test("完整构成严格检查覆盖、合法金额及总体",()=>{
  assert.equal(compositionStatus([80,20],100,true),null);
  assert.match(compositionStatus([80,null],100,true)!,/未产出/);
  assert.match(compositionStatus([0,0],0,true)!,/为0/);
  assert.match(compositionStatus([100,-5],95,true)!,/负数/);
  assert.match(compositionStatus([80,10],100,true)!,/不一致/);
  assert.match(compositionStatus([80,20],100,false)!,/未核对/);
});
