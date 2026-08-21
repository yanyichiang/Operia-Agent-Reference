export type BrowseWebArguments = {
  task?: unknown;
  starting_url?: unknown;
};

export type BrowseWebRoute =
  | { kind: "search_web"; args: { query: string; max_sources: number } }
  | { kind: "delegate_action"; task: string };

const INTERACTIVE_WEB_INTENT = /(?:交互(?:式)?(?:浏览器|网页)|点击|点开|进入\s*(?:页面|链接|下一页|releases?)|跳转|翻页|下一页|滚动|登录|登陆|填写|填入|输入|提交|选择|筛选|上传|持续观察|实时观察|接管|interactive\s+(?:browser|web)|click|follow\s+(?:the\s+)?link|navigate\s+to|go\s+to|open\s+(?:the\s+)?(?:page|link|releases?)|log\s*in|sign\s*in|fill(?:\s+in|\s+out)?|submit|select|choose|filter|scroll|next\s+page|paginate|upload|watch|observe)/iu;
const SEARCH_WEB_INTENT = /(?:搜索|检索|搜一下|查一下|查询|查找|找一下|最新|新闻|资料|全网|search|research|look\s*up|find|latest|news|across\s+the\s+web)/iu;
const HTTPS_URL = /https:\/\/[^\s<>()"']+/iu;

function normalizedStartingUrl(args: BrowseWebArguments, task: string): string {
  const explicit = typeof args.starting_url === "string" ? args.starting_url.trim() : "";
  return explicit || task.match(HTTPS_URL)?.[0]?.replace(/[.,;:!?，。；：！？]+$/u, "") || "";
}

export function routeBrowseWeb(args: BrowseWebArguments, originalUserText = ""): BrowseWebRoute {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) throw new Error("browse_web_task_required");
  const startingUrl = normalizedStartingUrl(args, task);
  const userText = originalUserText.trim();
  const routingText = userText ? `${task}\n${userText}` : task;
  const delegatedTask = userText && !task.includes(userText) ? `${task}\nOriginal user request: ${userText}` : task;

  // Escalation only adds planning and policy checks; it never bypasses approval.
  if (INTERACTIVE_WEB_INTENT.test(routingText)) {
    return { kind: "delegate_action", task: [
      "The rendered Browser capability is disabled. Do not simulate clicks, login, forms, uploads, or other UI interaction.",
      "Use sandbox-runtime/execute_script only if public read-only HTTP can satisfy the goal without rendering or interaction; otherwise return complete and explain that rendered UI is unavailable.",
      delegatedTask,
      startingUrl ? `Start at: ${startingUrl}` : "",
    ].filter(Boolean).join("\n") };
  }
  if (startingUrl) return { kind: "delegate_action", task: [
    "Use Sandbox for a read-only public HTTPS request. Do not use Browser.",
    delegatedTask,
    `URL: ${startingUrl}`,
  ].join("\n") };
  if (SEARCH_WEB_INTENT.test(routingText)) return { kind: "search_web", args: { query: task, max_sources: 5 } };
  return { kind: "delegate_action", task: delegatedTask };
}
