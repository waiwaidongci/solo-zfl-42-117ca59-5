const assert = require("assert");
const Core = require("./recipe-core.js");

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log("ok -", name);
}

const NOW = "2026-09-14 10:00";
function mk(over) {
  return Object.assign({
    id: Core.newId(), family: "f1", name: "配方", version: 1,
    material: "大漆", steps: ["描稿"], params: [{ k: "阴干时长h", v: "24" }],
    refs: [], status: "draft", note: "", logs: [], createdAt: NOW, finalizedAt: ""
  }, over);
}

t("复制生成递增版本", () => {
  const v1 = mk({ version: 1 });
  const v2 = Core.copyAsNewVersion([v1], v1.id, NOW);
  assert.strictEqual(v2.version, 2);
  assert.strictEqual(v2.status, "draft");
  const v3 = Core.copyAsNewVersion([v1, v2], v1.id, NOW); // 从旧版 v1 复制仍取最大版本+1
  assert.strictEqual(v3.version, 3);
  assert.strictEqual(v3.family, v1.family);
  assert.notStrictEqual(v3.id, v1.id);
  v1.params[0].v = "99"; // 深拷贝：改源不影响副本
  assert.strictEqual(v2.params[0].v, "24");
});

t("正常定稿：无引用或有引用且被引方已定稿", () => {
  const a = mk({ status: "final" });
  const b = mk({ refs: [a.id] });
  assert.deepStrictEqual(Core.finalizeErrors([a, b], b.id), []);
});

t("定稿拦截：自引用", () => {
  const a = mk();
  a.refs = [a.id];
  const errs = Core.finalizeErrors([a], a.id);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /自引用/);
});

t("定稿拦截：循环引用（含多级）", () => {
  const a = mk({ id: "A" }), b = mk({ id: "B" }), c = mk({ id: "C" });
  a.refs = ["B"]; b.refs = ["C"]; c.refs = ["A"];
  const errs = Core.finalizeErrors([a, b, c], a.id);
  // 环上的 B、C 均为草稿，循环引用与引用未定稿会同时报告
  assert.ok(errs.some(e => /循环引用/.test(e)));
  assert.ok(errs.some(e => /未定稿/.test(e)));
  // 自引用不会被重复报成循环引用
  const s = mk({ id: "S" }); s.refs = ["S"];
  assert.strictEqual(Core.finalizeErrors([s], s.id).length, 1);
});

t("定稿拦截：共享节点下的闭环（无环分支 + 公共节点成环）", () => {
  // S 先经无环分支 A、再经分支 B 汇聚到公共节点 C，C 与 D 自成闭环且不含 S
  const s = mk({ id: "S", name: "面漆" }), a = mk({ id: "A", name: "分支甲" }),
        b = mk({ id: "B", name: "分支乙" }), c = mk({ id: "C", name: "共享底" }),
        d = mk({ id: "D", name: "回环" });
  s.refs = ["A", "B"];
  a.refs = ["C"];
  b.refs = ["C"];
  c.refs = ["D"];
  d.refs = ["C"];
  const errs = Core.finalizeErrors([s, a, b, c, d], s.id);
  const msg = errs.find(e => /循环引用/.test(e));
  assert.ok(msg, "可达闭环必须拦住定稿");
  // 显示从起点到闭环的完整引用链，闭环节点在链上重复出现
  assert.strictEqual(msg, "存在循环引用：面漆 v1 → 分支甲 v1 → 共享底 v1 → 回环 v1 → 共享底 v1");
  // 同一拓扑断开闭环（D 不再回指 C）后，循环引用错误消失
  const dOpen = mk({ id: "D", name: "回环" });
  const errsOpen = Core.finalizeErrors([s, a, b, c, dOpen], s.id);
  assert.ok(!errsOpen.some(e => /循环引用/.test(e)));
});

t("定稿拦截：引用未定稿版本", () => {
  const a = mk(), b = mk({ refs: [a.id] });
  const errs = Core.finalizeErrors([a, b], b.id);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /未定稿/);
});

t("移除拦截：被定稿版本引用不可移除，被草稿引用可移除并清理引用", () => {
  const fin = mk({ id: "F", status: "final" });
  const target = mk({ id: "T" });
  fin.refs = ["T"];
  const blocked = Core.removeRecipe([fin, target], "T");
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.blockers[0].id, "F");

  const draft = mk({ id: "D", refs: ["T"] });
  const res = Core.removeRecipe([draft, target], "T");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.recipes.length, 1);
  assert.deepStrictEqual(res.recipes[0].refs, []);
});

t("差异比较：仅列出不同字段", () => {
  const x = mk({ id: "X", name: "甲", material: "大漆", params: [{ k: "温度", v: "25" }, { k: "时长", v: "24" }] });
  const y = mk({ id: "Y", name: "甲", material: "腰果漆", params: [{ k: "温度", v: "25" }, { k: "时长", v: "36" }], refs: ["X"] });
  const rows = Core.diffVersions(x, y, [x, y]);
  const fields = rows.map(r => r.field);
  assert.ok(fields.includes("材料"));
  assert.ok(fields.includes("参数·时长"));
  assert.ok(fields.includes("引用"));
  assert.ok(!fields.includes("参数·温度"));
  assert.ok(!fields.includes("名称"));
  assert.deepStrictEqual(Core.diffVersions(x, x, [x]), []);
});

t("筛选：参数范围", () => {
  const r = mk({ params: [{ k: "阴干时长h", v: "24" }, { k: "漆粉比", v: "3:1" }] });
  assert.strictEqual(Core.matchParamRange(r, "", "", ""), true);
  assert.strictEqual(Core.matchParamRange(r, "阴干", "", ""), true);
  assert.strictEqual(Core.matchParamRange(r, "不存在", "", ""), false);
  assert.strictEqual(Core.matchParamRange(r, "阴干", "20", "30"), true);
  assert.strictEqual(Core.matchParamRange(r, "阴干", "25", ""), false);
  assert.strictEqual(Core.matchParamRange(r, "", "10", "30"), true); // 任意数值参数落在区间
  assert.strictEqual(Core.matchParamRange(r, "漆粉比", "1", "5"), false); // 非数值不参与范围
});

t("筛选：引用关系", () => {
  const a = mk({ id: "A" }), b = mk({ id: "B", refs: ["A"] }), c = mk({ id: "C" });
  const all = [a, b, c];
  assert.strictEqual(Core.matchRefMode(all, b, "hasRefs"), true);
  assert.strictEqual(Core.matchRefMode(all, a, "hasRefs"), false);
  assert.strictEqual(Core.matchRefMode(all, c, "noRefs"), true);
  assert.strictEqual(Core.matchRefMode(all, a, "referenced"), true);
  assert.strictEqual(Core.matchRefMode(all, c, "referenced"), false);
  assert.strictEqual(Core.matchRefMode(all, b, "refsTo", "A"), true);
  assert.strictEqual(Core.matchRefMode(all, a, "referencedBy", "B"), true);
  assert.strictEqual(Core.matchRefMode(all, c, "referencedBy", "B"), false);
});

console.log(`\n${passed} 项核心逻辑测试全部通过`);
