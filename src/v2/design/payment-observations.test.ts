import {test} from "node:test";
import assert from "node:assert/strict";
import {paymentAggregate,paymentDates,paymentGroups,paymentMetric,paymentBusinessAggregate,paymentWays} from "./payment-observations.ts";
test("支付方式汇总守恒，去重人数与全部复合指标使用原始计算输入",()=>{
  for(const range of [{start:"2026-09-08",end:"2026-09-08"},{start:"2026-09-02",end:"2026-09-08"},{start:"2026-08-01",end:"2026-09-08"}]){
    const overall=paymentBusinessAggregate(range),parts=paymentWays.slice(1).map(way=>paymentBusinessAggregate(range,way.id));
    for(const key of ["requests","successes","amount"] as const)assert.ok(Math.abs(parts.reduce((sum,row)=>sum+row.inputs[key],0)-overall.inputs[key])<.000001);
    assert.equal(overall.inputs.amount,paymentAggregate(range).amount);
    assert.equal(overall.inputs.paidUsers,paymentAggregate(range).users);
    assert.ok(parts.reduce((sum,row)=>sum+row.inputs.paidUsers,0)>overall.inputs.paidUsers);
    for(const row of [overall,...parts]){
      assert.equal(row.values.M114,row.inputs.successes/row.inputs.requests);
      assert.equal(row.values.M061,row.inputs.paidUsers/row.inputs.activeUsers);
      assert.equal(row.values.M087,row.inputs.amount/row.inputs.activeUsers);
      assert.equal(row.values.M067,row.inputs.amount/row.inputs.paidUsers);
      assert.ok(row.inputs.requestUsers<=row.inputs.requests);
      assert.ok(row.inputs.paidUsers<=row.inputs.requestUsers);
      assert.equal(row.inputs.activeUsers,overall.inputs.activeUsers);
    }
  }
});
test("商品、端别、新老金额同源回对，人数保留跨日跨组去重",()=>{
  const range={start:"2026-09-02",end:"2026-09-08"},total=paymentAggregate(range);
  for(const dimension of ["stage","product","client"] as const) assert.ok(Math.abs(paymentGroups[dimension].reduce((sum,g)=>sum+paymentAggregate(range,{[dimension]:g.id}).amount,0)-total.amount)<.001);
  const dailyUsers=paymentDates(range).reduce((sum,date)=>sum+paymentAggregate({start:date,end:date}).users,0);
  assert.ok(dailyUsers>total.users);
  assert.ok(paymentAggregate(range,{stage:"new"}).users+paymentAggregate(range,{stage:"old"}).users>total.users);
  assert.equal(paymentMetric("M067",range),total.amount/total.users);
  assert.equal(paymentMetric("M058",range),total.amount);
  assert.ok(Math.abs(paymentMetric("M065",range)+paymentMetric("M066",range)-total.amount)<.001);
});
