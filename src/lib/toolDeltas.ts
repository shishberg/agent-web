export type ToolDeltaGroup = {
  key: string;
  label: string;
  detail?: string;
  status?: ToolDeltaStatus;
  statusLabel?: string;
  content: string;
};

export type ToolDeltaStatus = "running" | "done" | "error";

export function groupToolDeltas(deltas: string[]): ToolDeltaGroup[] {
  const groups: InternalToolDeltaGroup[] = [];

  deltas.forEach((delta, index) => {
    const value = parseToolDelta(delta);
    const object = objectField(value);
    const id = object ? rawToolDeltaId(object) : "";
    const fallbackKey = id || `tool-${index}`;
    const existing = groups.find((group) => group.id && group.id === id);
    const group = existing ?? createToolGroup(fallbackKey, id);

    if (!existing) {
      groups.push(group);
    }

    if (object) {
      group.hasObject = true;
      group.name ||= toolName(object);
      group.detail ||= toolDetail(object, group.name);
      group.completed ||= isToolCompletion(object);
      group.failed ||= isToolFailure(object);
    }

    group.parts.push(formatToolDeltaValue(value));
  });

  return groups.map((group) => {
    const status = toolGroupStatus(group);

    return {
      key: group.key,
      label: toolGroupLabel(group),
      detail: group.detail || undefined,
      status,
      statusLabel: toolGroupStatusLabel(status),
      content: group.parts.filter(Boolean).join("\n\n")
    };
  });
}

export function rawToolDeltaId(object: Record<string, unknown>): string {
  return firstString(object.toolCallId, object.toolExecutionId, object.tool_use_id, object.toolUseId, object.id);
}

function createToolGroup(key: string, id: string): InternalToolDeltaGroup {
  return {
    key,
    id,
    name: "",
    detail: "",
    hasObject: false,
    completed: false,
    failed: false,
    parts: []
  };
}

type InternalToolDeltaGroup = {
  key: string;
  id: string;
  name: string;
  detail: string;
  hasObject: boolean;
  completed: boolean;
  failed: boolean;
  parts: string[];
};

function toolGroupLabel(group: InternalToolDeltaGroup): string {
  return group.name || "Tool call";
}

function toolGroupStatus(group: InternalToolDeltaGroup): ToolDeltaStatus | undefined {
  if (!group.hasObject) {
    return undefined;
  }

  if (group.failed) {
    return "error";
  }

  return group.completed ? "done" : "running";
}

function toolGroupStatusLabel(status: ToolDeltaStatus | undefined): string | undefined {
  switch (status) {
    case "running":
      return "In progress";
    case "done":
      return "Complete";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function isToolCompletion(object: Record<string, unknown>): boolean {
  const type = typeof object.type === "string" ? object.type : "";
  return type === "tool_execution_end" || type === "toolResult" || type === "tool_result" || object.role === "toolResult";
}

function isToolFailure(object: Record<string, unknown>): boolean {
  const result = objectField(object.result);
  return (
    object.isError === true ||
    object.is_error === true ||
    object.error === true ||
    object.success === false ||
    result?.isError === true ||
    result?.is_error === true ||
    result?.error === true ||
    result?.success === false
  );
}

function formatToolDeltaValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function toolName(object: Record<string, unknown>): string {
  return firstDisplayValue(object.toolName, object.tool_name, object.name, object.tool);
}

function toolDetail(object: Record<string, unknown>, name: string): string {
  if (name === "bash") {
    return commandDetail(object);
  }

  return pathDetail(object) || commandDetail(object);
}

function commandDetail(object: Record<string, unknown>): string {
  const args = objectField(object.args);
  const input = objectField(object.input);
  const argumentsValue = objectField(object.arguments);
  return firstString(args?.command, input?.command, argumentsValue?.command, object.command);
}

function pathDetail(object: Record<string, unknown>): string {
  const args = objectField(object.args);
  const input = objectField(object.input);
  const argumentsValue = objectField(object.arguments);
  return firstString(
    object.path,
    object.file_path,
    object.filePath,
    args?.path,
    args?.file_path,
    args?.filePath,
    input?.path,
    input?.file_path,
    input?.filePath,
    argumentsValue?.path,
    argumentsValue?.file_path,
    argumentsValue?.filePath
  );
}

function firstDisplayValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized && !looksLikeUuid(normalized)) {
        return normalized;
      }
      continue;
    }

    const object = objectField(value);
    if (object) {
      const nested = firstDisplayValue(object.name, object.displayName, object.label, object.id);
      if (nested) {
        return nested;
      }
    }
  }

  return "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function parseToolDelta(delta: string): unknown {
  try {
    return JSON.parse(delta);
  } catch {
    return delta;
  }
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
