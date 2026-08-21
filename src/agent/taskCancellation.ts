export class ActiveTaskCalls {
  private readonly calls = new Map<string, Set<AbortController>>();

  register(taskId: string, parent: AbortSignal): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    const set = this.calls.get(taskId) ?? new Set<AbortController>();
    set.add(controller);
    this.calls.set(taskId, set);
    const relay = () => controller.abort(parent.reason ?? "parent_aborted");
    parent.addEventListener("abort", relay, { once: true });
    if (parent.aborted) relay();
    return { signal: controller.signal, release: () => {
      parent.removeEventListener("abort", relay);
      set.delete(controller);
      if (set.size === 0) this.calls.delete(taskId);
    } };
  }

  abortTask(taskId: string): void {
    for (const controller of this.calls.get(taskId) ?? []) controller.abort("task_cancelled");
  }

  abortAll(reason = "global_pause"): void {
    for (const controllers of this.calls.values()) {
      for (const controller of controllers) controller.abort(reason);
    }
  }
}

export function assertTaskResultActive(cancelled: boolean, signal: AbortSignal): void {
  if (cancelled || signal.aborted) throw new DOMException("Task cancelled after external response", "AbortError");
}
