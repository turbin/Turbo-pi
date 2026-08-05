# 2026-08-05 agent-server 注入开关 + eval preflight 门禁 — 决策记录

## 背景

用户重申最终目标：**agent-server 通过模型 trace 持续提升能力，最终不依赖外部模型处理复杂任务**。审查发现架构缺口：此前所有基线跑批（L1/L2、27B 冷库 v2）物理旁路 8789，trace 不进经验库，学习回路对控制臂失明（E5 靠事后手工合成轨迹补，是补丁不是设计）。且 agent-server 无注入开关，想做"同路径对照"只能旁路。另一教训：跑批撞死服务会白烧数小时（8789 down 事件）。

## 决策

### 【立】决策 1：注入开关（injection toggle）

- 服务级默认：`AGENT_SERVER_INJECTION=off` 关闭（默认 on，向后兼容）；`createServer({ injection })` 可注入（测试用）。
- 请求级覆盖：`/v1/chat/completions` body `injection: true/false`；`/api/stream` 的 `options.injection`。显式布尔覆盖服务默认。
- 关闭语义：跳过 retrieve + buildInjection（**含 skill catalog 与 SOP schema 合并**——纯 retrieve=[] 仍会注入目录，不够"对照"），模型看到的就是调用方原始 context。
- **session 记录与 request trace 无条件保留**——这是开关的存在意义：控制臂留在学习回路里。
- 可区分性：session 的 `experience_injection` 条目带 `disabled: true`，区分"开关关闭"与"检索未命中"；logTrace 带 `injection: "off"`。
- 实现点：`types.ts`（ProxyStreamOptions.injection）、`proxy-handler.ts`（handleStream 单分支）、`server.ts`（env 默认 + /v1 流式分支内联检索同样接开关）。

### 【立】决策 2：控制臂跑法变更——同路径对照取代物理旁路

- 基线臂：`--base-url http://127.0.0.1:8789/v1 --injection off`；实验臂同地址 `--injection on`（或省略走服务默认）。
- 理由：两臂走完全相同代码路径（更严格的 A/B），且基线轨迹落库（R2 进料三路合并需要败局对照）。
- 例外：DeepSeek 直连臂（8899 中继）保持旁路——它是"无学生系统"的绝对上限参照，不是注入对照。
- 历史数据口径不变：L2/27B 冷库 v2 是旁路基线，与新同路径基线对比时须在报告中注明 harness 差异（8789 代理一跳的开销与 session 记录）。

### 【立】决策 3：preflight 环境依赖门禁（eval/preflight.py）

- 所有跑批入口（alfworld_agent.py、harness.py、d3_discriminate.py）启动前必过 `ensure_for_base_url(base_url)`。
- 依赖链按端口推导：8789→[omlx, gateway, agent-server]；8787→[omlx, gateway]；8899→[relay]；外部 URL→无本地依赖。
- 自有服务（8789/8787/8899）down 时 **nohup 自动拉起**（标准 env 内嵌，gateway/relay 从 `packages/agent-server/.env` 取 DEEPSEEK_*），等待就绪最长 90s；omlx 是用户管理的 app，只探活，不起。
- 探活口径：任意 HTTP 响应即活（omlx 401、agent-server /stats 200）。
- 理由：受管后台任务双死法（会话结束 SIGTERM + 24h 上限）导致服务静默消失是重复事故；自动拉起消灭"跑批撞死服务白烧数小时"这一类失败。

## 验证

- TDD：proxy-handler.test.ts 新增 2 用例（请求级关闭仍记录 session 且无注入；服务级 off + 请求级覆盖恢复）；vitest 24 文件 256 全绿（基线 254+2）。
- preflight 实机验证：四路径（8789/8787/8899/外部）探活正确；kill 8789 后 preflight 自动拉起成功。
- `npm run check` 干净（biome/pinned-deps/ts-imports/shrinkwrap/tsgo/browser-smoke）。

## 影响面

- 不动正在跑的 27B 冷库 v2（直连 8787，不经过 8789；其为旁路基线，口径见决策 2）。
- 生产 compose 栈（8788）默认注入 on，行为不变。
- B 阶段热库轮起，双臂跑法按决策 2 执行。

Refer Spec：2026-07-18-agent-server-experience-replay-spec.md（§5.1 在线回放、§6 session 记录）；2026-08-04-agent-server-c3-amendment-and-r2-evolution-input-changes-and-decisions.md（R2 进料三路合并）
