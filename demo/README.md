# 演示站附属件（已冻结）

> **⚠️ 2026-11-05 起冻结**：演示站不再更新维护（线上 demo.bloghao.com 仍在跑，但不再跟随本仓库变化）。

- `hub-node/`：演示站用的轻量 hub（Node + D1 shim）
- `subdomain-signup.html`：当年给访客自助开子站域名的页面

**注意**：`src/demo.ts` 的 `DEMO_MODE` 门控**没有冻结**——它是防误操作的安全网（演示站禁止外发等），
随主线继续维护。机制说明见 [../docs/DEMO.md](../docs/DEMO.md)（同样已冻结）。

冻结范围与理由见 [../docs/MAINTENANCE.md](../docs/MAINTENANCE.md)。
