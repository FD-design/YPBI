import { expect, test } from "bun:test";
import { analysisGroupId, reduceAnalysisGroupVisibility, type AnalysisGroupVisibilityState, type AnalysisGroupVisibilityAction } from "./AnalysisScopeControls";

const clients = ["android", "ios"], audiences = ["new", "existing"];
const apply = (state?: AnalysisGroupVisibilityState, action?: AnalysisGroupVisibilityAction, query = "query-1") => reduceAnalysisGroupVisibility(state, clients, audiences, query, action);

test("默认四组，单图例隐藏后保持精确三组，不重建笛卡尔积", () => {
  const all = apply();
  expect(all.groups).toEqual(["android:new", "android:existing", "ios:new", "ios:existing"]);
  const three = apply(all, { type: "toggle", id: analysisGroupId("ios", "existing") });
  expect(three.groups).toHaveLength(3);
  expect(apply(three).groups).toEqual(three.groups);
  expect(apply(three, { type: "clients", values: clients }).groups).toEqual(three.groups);
  expect(apply(three, { type: "audiences", values: audiences }).groups).toEqual(three.groups);
  expect(apply(three, { type: "reset" }).groups).toEqual(all.groups);
});

test("精确对角两组保持互不串组，setGroups去重并忽略未知值", () => {
  const diagonal = apply(undefined, { type: "groups", values: ["ios:existing", "android:new", "android:new", "web:new"] });
  expect(diagonal.groups).toEqual(["android:new", "ios:existing"]);
  expect(apply(diagonal, { type: "clients", values: clients }).groups).toEqual(diagonal.groups);
  expect(apply(diagonal, { type: "audiences", values: audiences }).groups).toEqual(diagonal.groups);
  expect(apply(diagonal, { type: "toggle", id: "unknown:group" }).groups).toEqual(diagonal.groups);
});

test("维度开关只批量改变对应组，不补回其他手工隐藏格", () => {
  const three = apply(undefined, { type: "groups", values: ["android:new", "android:existing", "ios:new"] });
  const ios = apply(three, { type: "clients", values: ["ios"] });
  expect(ios.groups).toEqual(["ios:new"]);
  const restoreClient = apply(ios, { type: "clients", values: clients });
  expect(restoreClient.groups).toEqual(["android:new", "ios:new"]);
  const restoreAudience = apply(restoreClient, { type: "audiences", values: audiences });
  expect(restoreAudience.groups).toEqual(apply().groups);
});

test("至少保留一组；空请求、全未知与取消最后一组都不清空", () => {
  const one = apply(undefined, { type: "selectOnly", client: "android", audience: "new" });
  expect(one.groups).toEqual(["android:new"]);
  for (const action of [{ type: "groups", values: [] }, { type: "groups", values: ["missing"] }, { type: "clients", values: [] }, { type: "audiences", values: [] }, { type: "toggle", id: "android:new" }] as AnalysisGroupVisibilityAction[]) expect(apply(one, action)).toEqual(one);
});

test("查询及能力变化恢复全部有效组，不保留旧范围选中", () => {
  const one = apply(undefined, { type: "selectOnly", client: "android", audience: "new" });
  expect(apply(one, undefined, "query-2").groups).toEqual(apply().groups);
  expect(reduceAnalysisGroupVisibility(one, ["ios"], ["overall"], "query-1").groups).toEqual(["ios:overall"]);
  expect(reduceAnalysisGroupVisibility(one, [], audiences, "query-1").groups).toEqual([]);
  expect(apply(one, { type: "groups", values: [] }, "query-2").groups).toEqual(apply().groups);
});

test("selectOnly支持单端全部人群，恢复不改变业务总体或查询键", () => {
  const all = apply(), focused = apply(all, { type: "selectOnly", client: "ios" });
  expect(focused.groups).toEqual(["ios:new", "ios:existing"]);
  expect(focused.key).toBe(all.key);
  expect(apply(focused, { type: "reset" })).toEqual(all);
});
