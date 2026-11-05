# 2026-11 全项目深度审计（已归档）

> 归档时间：2026-11-06。这四份文件原先随手放在仓库根目录（占根目录 995 行），
> 阶段 C 已全部上线，按 docs/archive 的惯例收进这里——**结论仍有效，但不再是操作入口**。
> 现在该看的是：`AGENTS.md`（长期防线）、`docs/MAINTENANCE.md`（日常运维）、
> `docs/DEPLOY-ORACLE.md`（部署与排障）。

| 文件 | 是什么 | 什么时候看 |
| --- | --- | --- |
| [ARCHITECTURE_REPORT.md](ARCHITECTURE_REPORT.md) | 阶段 A：全项目架构摸底（生产怎么跑、数据怎么流、各模块职责） | 接手项目、改入口链路之前 |
| [AUDIT_REPORT.md](AUDIT_REPORT.md) | 阶段 A：问题清单（P0×1 / P1×13 / P2×27 / P3×30），每条带证据与复现 | 想知道某个设计为什么长这样 |
| [REMEDIATION_PLAN.md](REMEDIATION_PLAN.md) | 阶段 B：修复计划（R1-R11 批次、顺序、每批范围） | 追溯某个修复属于哪一批 |
| [AUDIT_PROGRESS.md](AUDIT_PROGRESS.md) | 过程台账：批次执行、与站长并行修复的对账、上线记录 | 追溯「这条结论是什么时候下的」 |

**基线**：审计对象 commit `864c73f`（2026-11-04）；修复批次合入 `a730744`／复核 `4158711`。
文中的文件名、行号、测试数量都停留在那个时点，不要拿它们当现状——现行口径以代码与 AGENTS.md 为准。
