import type { Observability } from "agents/observability";
import { projectSdkObservabilityEvent, type ProjectedSdkEvent } from "./agentObservabilityProjection";

export function createOperiaObservability(project: (event: ProjectedSdkEvent) => void): Observability {
  return {
    emit(event) {
      const projected = projectSdkObservabilityEvent(event);
      if (projected) project(projected);
    },
  };
}
