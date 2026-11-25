// AI 调用预算：限制每个用户动作最多调用几次大模型。
// 一次精修指令 = 理解 1 次 + 定向修复最多 1 次；用完就停，给出中文提示，绝不无限重试。
// 注意：主进程 AI 适配器内部在「输出不是合法 JSON」时的单次重发不经过这里，由主进程侧另行限制。

/** 每种用户动作的大模型调用上限（含修复） */
export const LLM_BUDGET = Object.freeze({
  edit: 2,        // AI 精修：理解 1 次 + 定向修复 1 次
  director: 1,    // AI 导演对话
  storyboard: 1,  // 生成分镜
  shot: 1,        // 单镜修改
  analyze: 1,     // 拆片分析
  tags: 1,        // 素材打标签
});

export class BudgetExceededError extends Error {
  constructor(action, limit) {
    super(`这次操作已经请 AI 处理了 ${limit} 次，达到上限，先停在这里。可以换个说法再试一次`);
    this.name = 'BudgetExceededError';
    this.code = 'LLM_BUDGET';
    this.action = action;
    this.limit = limit;
  }
}

export function isBudgetExceeded(err) {
  return !!err && (err.code === 'LLM_BUDGET' || err.name === 'BudgetExceededError');
}

/** 某种动作的上限；未登记的动作按 1 次算 */
export function budgetLimit(action) {
  const n = LLM_BUDGET[action];
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * 为一次用户动作创建调用计数器。
 * @param {string} action LLM_BUDGET 的键
 * @param {number} [limit]
 */
export function createBudget(action, limit = budgetLimit(action)) {
  let used = 0;
  const log = [];
  return {
    action,
    limit,
    get used() { return used; },
    remaining() { return Math.max(0, limit - used); },
    canSpend(n = 1) { return used + n <= limit; },
    /** 扣 1 次额度；已用完时抛 BudgetExceededError（不会发出请求） */
    spend(label = '') {
      if (used >= limit) throw new BudgetExceededError(action, limit);
      used += 1;
      log.push(String(label || ''));
      return used;
    },
    calls() { return [...log]; },
  };
}

/** 计数包装：每次调用前先扣额度，超限时直接抛错、不调用 fn */
export function withBudget(budget, fn, label = '') {
  return async (...args) => {
    budget.spend(label || (fn && fn.name) || '');
    return fn(...args);
  };
}
