import { ControlPlaneCoreError } from "./errors";
import { validateRouteTemplate } from "./routes";
import type { ControlManifest, ControlTopology } from "./types";

export function validateControlManifest(manifest: ControlManifest): void {
  if (manifest.manifestVersion !== 1 || !nonEmpty(manifest.registryVersion) || !isDomain(manifest.domain)) {
    throw new ControlPlaneCoreError("invalid_manifest", "identity");
  }
  if (!validTimestamp(manifest.generatedAt) || !unique(manifest.owns) || !unique(manifest.sections.map(({ id }) => id))) {
    throw new ControlPlaneCoreError("invalid_manifest", "duplicates_or_time");
  }
  if (!unique(manifest.sections.map(({ routeTemplateId }) => routeTemplateId))) {
    throw new ControlPlaneCoreError("invalid_manifest", "duplicate_route_template");
  }
  if (manifest.consumes.some(({ ownerDomain, keys }) => !isDomain(ownerDomain) || !unique(keys))) {
    throw new ControlPlaneCoreError("invalid_manifest", "invalid_consumes");
  }
  if (Object.values(manifest.schemaVersions).some((version) => !Number.isSafeInteger(version) || version < 1)) {
    throw new ControlPlaneCoreError("invalid_manifest", "invalid_schema_version");
  }
}

export function validateControlTopology(topology: ControlTopology): void {
  if (topology.topologyVersion !== 1 || !nonEmpty(topology.registryVersion) || !validTimestamp(topology.generatedAt)) {
    throw new ControlPlaneCoreError("invalid_topology", "identity");
  }
  const domains = topology.domains.map(({ domain }) => domain);
  const templateIds = topology.routeTemplates.map(({ id }) => id);
  if (!unique(domains) || !unique(templateIds)) throw new ControlPlaneCoreError("invalid_topology", "duplicates");
  if (topology.domains.some(({ domain, routeTemplateIds }) => !isDomain(domain) || !unique(routeTemplateIds))) {
    throw new ControlPlaneCoreError("invalid_topology", "invalid_domain");
  }
  if (topology.domains.some(({ manifestPath }) => manifestPath !== "/api/control/manifest" && manifestPath !== "/service/control/manifest")) {
    throw new ControlPlaneCoreError("invalid_topology", "invalid_manifest_path");
  }
  for (const template of topology.routeTemplates) validateRouteTemplate(template, domains);
  const templatesById = new Map(topology.routeTemplates.map((template) => [template.id, template]));
  const referencedTemplateIds = topology.domains.flatMap(({ routeTemplateIds }) => routeTemplateIds);
  if (!unique(referencedTemplateIds) || referencedTemplateIds.length !== topology.routeTemplates.length) {
    throw new ControlPlaneCoreError("invalid_topology", "unowned_route_template");
  }
  for (const domain of topology.domains) {
    for (const id of domain.routeTemplateIds) {
      const template = templatesById.get(id);
      if (!template || template.ownerDomain !== domain.domain) {
        throw new ControlPlaneCoreError("invalid_topology", "route_ownership");
      }
    }
  }
}

export function assertManifestMatchesTopology(manifest: ControlManifest, topology: ControlTopology): void {
  validateControlManifest(manifest);
  validateControlTopology(topology);
  if (manifest.registryVersion !== topology.registryVersion) throw new ControlPlaneCoreError("invalid_manifest", "registry_version");
  const domain = topology.domains.find((entry) => entry.domain === manifest.domain);
  if (!domain) throw new ControlPlaneCoreError("invalid_manifest", "unknown_domain");
  if (manifest.sections.some(({ routeTemplateId }) => !domain.routeTemplateIds.includes(routeTemplateId))) {
    throw new ControlPlaneCoreError("invalid_manifest", "unknown_route_template");
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: string): boolean {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function unique(values: readonly string[]): boolean {
  return values.every(nonEmpty) && new Set(values).size === values.length;
}

function isDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) && value.includes(".");
}
