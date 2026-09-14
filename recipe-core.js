/*
 * 工艺配方版本库 —— 核心逻辑（纯函数，无 DOM 依赖）
 * 浏览器中挂在 window.RecipeCore，Node 中通过 require 加载，便于单测。
 *
 * 配方版本数据模型：
 * {
 *   id, family,          // id 唯一；family 标识同一配方的版本链
 *   name, version,       // version 在 family 内递增
 *   material,            // 材料
 *   steps: [],           // 工序（有序）
 *   params: [{k, v}],    // 参数键值对
 *   refs: [id],          // 引用的其他版本
 *   status: "draft" | "final",   // 定稿后只读
 *   note, logs: [],
 *   createdAt, finalizedAt
 * }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RecipeCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function byId(recipes) {
    return new Map(recipes.map(r => [r.id, r]));
  }

  function labelOf(recipes, id) {
    const t = byId(recipes).get(id);
    return t ? `${t.name} v${t.version}` : "已删除版本";
  }

  /** 同一 family 内的下一个版本号 */
  function nextVersion(recipes, family) {
    return recipes
      .filter(r => r.family === family)
      .reduce((max, r) => Math.max(max, r.version), 0) + 1;
  }

  /** 从任一旧版复制生成递增版本（草稿），字段深拷贝，引用一并复制 */
  function copyAsNewVersion(recipes, id, now) {
    const src = byId(recipes).get(id);
    if (!src) return null;
    return {
      id: newId(),
      family: src.family,
      name: src.name,
      version: nextVersion(recipes, src.family),
      material: src.material,
      steps: [...(src.steps || [])],
      params: (src.params || []).map(p => ({ k: p.k, v: p.v })),
      refs: [...(src.refs || [])],
      status: "draft",
      note: src.note || "",
      logs: [`${now} 复制自 v${src.version}，生成 v${nextVersion(recipes, src.family)}`],
      createdAt: now,
      finalizedAt: ""
    };
  }

  /**
   * 从 startId 出发沿引用边寻找回到 startId 的路径（循环引用）。
   * 起点指向自身的边由“自引用”单独报告，这里跳过，避免重复。
   */
  function findCyclePath(recipes, startId) {
    const map = byId(recipes);
    const start = map.get(startId);
    if (!start) return null;
    const visited = new Set([startId]);
    function dfs(currentId, path) {
      if (currentId === startId) return path;
      if (visited.has(currentId)) return null;
      visited.add(currentId);
      const node = map.get(currentId);
      if (!node) return null;
      for (const next of node.refs || []) {
        const found = dfs(next, path.concat(next));
        if (found) return found;
      }
      return null;
    }
    for (const ref of start.refs || []) {
      if (ref === startId) continue; // 自引用单独报告
      const found = dfs(ref, [startId, ref]);
      if (found) return found;
    }
    return null;
  }

  /**
   * 定稿前校验，返回错误信息数组，空数组表示可以定稿。
   * 三类引用异常：自引用、循环引用、引用未定稿版本。
   */
  function finalizeErrors(recipes, id) {
    const map = byId(recipes);
    const r = map.get(id);
    if (!r) return ["版本不存在"];
    if (r.status === "final") return ["该版本已是定稿，无需重复定稿"];
    const errors = [];
    const refs = r.refs || [];
    if (refs.includes(id)) {
      errors.push(`存在自引用：${labelOf(recipes, id)} 引用了自身`);
    }
    const cycle = findCyclePath(recipes, id);
    if (cycle) {
      errors.push(`存在循环引用：${cycle.map(x => labelOf(recipes, x)).join(" → ")}`);
    }
    for (const refId of refs) {
      if (refId === id) continue;
      const t = map.get(refId);
      if (!t) errors.push("引用的版本不存在（可能已被移除）");
      else if (t.status !== "final") errors.push(`引用了未定稿版本：${labelOf(recipes, refId)}`);
    }
    return errors;
  }

  /** 引用了 id 的定稿版本 —— 非空则 id 不可移除 */
  function removalBlockers(recipes, id) {
    return recipes.filter(r => r.status === "final" && (r.refs || []).includes(id));
  }

  /**
   * 移除版本。被定稿版本引用时拒绝并返回 blockers；
   * 否则删除该版本，并同步清掉草稿中对它的引用（定稿版本不可能引用它，否则已被拦截）。
   */
  function removeRecipe(recipes, id) {
    const blockers = removalBlockers(recipes, id);
    if (blockers.length) return { ok: false, blockers, recipes };
    const next = recipes
      .filter(r => r.id !== id)
      .map(r => (r.refs || []).includes(id)
        ? Object.assign({}, r, { refs: r.refs.filter(x => x !== id) })
        : r);
    return { ok: true, blockers: [], recipes: next };
  }

  /** 任意两版字段差异：返回 [{field, a, b}]，仅包含不同的字段 */
  function diffVersions(a, b, recipes) {
    const rows = [];
    const push = (field, va, vb) => {
      if (String(va) !== String(vb)) rows.push({ field, a: String(va), b: String(vb) });
    };
    push("名称", a.name, b.name);
    push("材料", a.material, b.material);
    push("工序", (a.steps || []).join("、") || "无", (b.steps || []).join("、") || "无");
    const pa = new Map((a.params || []).map(p => [p.k, p.v]));
    const pb = new Map((b.params || []).map(p => [p.k, p.v]));
    const keys = [];
    (a.params || []).concat(b.params || []).forEach(p => {
      if (!keys.includes(p.k)) keys.push(p.k);
    });
    keys.forEach(k => push(`参数·${k}`, pa.has(k) ? pa.get(k) : "—", pb.has(k) ? pb.get(k) : "—"));
    const refLabel = r => (r.refs || []).map(x => labelOf(recipes || [], x)).join("、") || "无";
    push("引用", refLabel(a), refLabel(b));
    push("备注", a.note || "无", b.note || "无");
    return rows;
  }

  /** 参数范围筛选：key 为空匹配任意参数；min/max 留空表示不限制 */
  function matchParamRange(recipe, key, min, max) {
    const hasRange = min !== "" && min != null || max !== "" && max != null;
    if (!key && !hasRange) return true;
    const entries = (recipe.params || []).filter(p => !key || p.k.includes(key));
    if (!entries.length) return false;
    if (!hasRange) return true;
    const lo = min === "" || min == null ? -Infinity : Number(min);
    const hi = max === "" || max == null ? Infinity : Number(max);
    return entries.some(p => {
      const n = Number(p.v);
      return !Number.isNaN(n) && n >= lo && n <= hi;
    });
  }

  /** 引用关系筛选 */
  function matchRefMode(recipes, recipe, mode, targetId) {
    const refs = recipe.refs || [];
    switch (mode) {
      case "hasRefs": return refs.length > 0;
      case "noRefs": return refs.length === 0;
      case "referenced":
        return recipes.some(r => r.id !== recipe.id && (r.refs || []).includes(recipe.id));
      case "refsTo": return !!targetId && refs.includes(targetId);
      case "referencedBy": {
        const t = byId(recipes).get(targetId);
        return !!t && (t.refs || []).includes(recipe.id);
      }
      default: return true;
    }
  }

  return {
    newId,
    nextVersion,
    copyAsNewVersion,
    findCyclePath,
    finalizeErrors,
    removalBlockers,
    removeRecipe,
    diffVersions,
    matchParamRange,
    matchRefMode,
    labelOf
  };
});
