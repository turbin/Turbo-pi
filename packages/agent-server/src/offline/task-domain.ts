/**
 * 任务→域注册表（F3 / T4，issue-012 采纳项 5 落地）。
 *
 * ETL 打标路径与 collectTrajectories 离线侧按 session 所属任务的 task_id
 * 推导 domain（payload.domain）；在线侧由 harness 显式传 domain（campaign.py
 * / alfworld_agent.py extra_body），不依赖本注册表。
 *
 * 规则（与 python/verification_selection/domains.py 镜像，改动需同步）：
 * - alfworld 任务（task_id 含 "alfworld"）→ "alfworld"；
 * - office campaign 任务（QCB 语料，task_id 形如 task_<编号>_<slug>）→ "office"；
 * - 其余 → ""（无标签：检索不过滤，向后兼容存量卡）。
 */

export function domainForTask(taskId: string): string {
	if (!taskId) return "";
	if (taskId.includes("alfworld")) return "alfworld";
	// office campaign 任务（QCB 语料）：task_<编号>_<slug>，可能带臂前缀
	// （control-task_... / experiment-task_...，session 级命名）。
	if (/\btask_\d+/.test(taskId)) return "office";
	return "";
}
