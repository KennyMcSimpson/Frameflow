// 工程文件版本迁移（纯函数，不 import ui）。
// 规则：
// - normalizeProject 只负责「补齐字段、兜住坏数据」，不改变结构含义；
// - 结构/语义升级都写成这里的一步迁移，按版本号顺序执行，每步只跑一次（跑完写回 version）；
// - 打开工程统一走 loadProject(raw)：先规范化再迁移，迁移过的工程由调用方安排保存，下次不再重复迁移。
import { normalizeProject, PROJECT_VERSION } from './model.js';
import { migrateShotCaptions } from './firstcut.js';

export const CURRENT_VERSION = PROJECT_VERSION;

/** 迁移步骤：to 为迁移后的版本号；run(project) 返回新工程（不修改入参）和可选说明 */
export const MIGRATIONS = [
  {
    to: 3,
    label: '镜头文案字幕放到文字轨',
    run(project) {
      // 第 3 版之前，镜头文案直接画在画面上；之后统一放在文字轨，用户可以改、可以删。
      // 只在升级时生成一次，并写下 captionsMigrated：用户之后删掉的字幕不会在重开时复活。
      const migrated = migrateShotCaptions(project);
      const made = migrated !== project ? (migrated.tracks.text || []).length : 0;
      return {
        project: { ...migrated, timeline: { ...(migrated.timeline || {}), captionsMigrated: true } },
        note: made ? `已把 ${made} 条镜头文案放到文字轨` : null,
      };
    },
  },
];

/**
 * 把已规范化的工程升级到当前版本。
 * @returns {{ project, changed: boolean, from: number, to: number, notes: string[] }}
 * 比当前版本还新的工程（用更新版本的应用保存过）原样返回，不降级。
 */
export function migrateProject(project) {
  if (!project || typeof project !== 'object') return { project, changed: false, from: 0, to: 0, notes: [] };
  const from = Number(project.version) || 2;
  let cur = project;
  const notes = [];
  for (const step of MIGRATIONS) {
    if ((Number(cur.version) || 2) >= step.to) continue;
    const r = step.run(cur) || {};
    cur = { ...(r.project || cur), version: step.to };
    if (r.note) notes.push(r.note);
  }
  return { project: cur, changed: cur !== project, from, to: Number(cur.version) || from, notes };
}

/**
 * 打开工程的统一入口：规范化（修复坏数据）→ 迁移到当前版本。
 * @param {object} raw 从磁盘读到的工程 JSON
 * @returns {{ project, migrated: boolean, repairs: string[], notes: string[] }}
 *   migrated 为 true 时调用方应尽快保存，让迁移结果落盘；repairs 是需要告诉用户的修复说明。
 */
export function loadProject(raw) {
  const repairs = [];
  const normalized = normalizeProject(raw, { report: (m) => repairs.push(String(m)) });
  const m = migrateProject(normalized);
  return { project: m.project, migrated: m.changed, repairs, notes: m.notes };
}
