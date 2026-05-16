export type ToolDeltaGroup = {
  key: string;
  label: string;
  content: string;
};

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
      group.name ||= toolName(object);
      group.hasCommand ||= deltaHasCommand(object);
      group.completed ||= isToolCompletion(object);
    }

    group.parts.push(formatToolDeltaValue(value));
  });

  return groups.map((group) => ({
    key: group.key,
    label: toolGroupLabel(group),
    content: group.parts.filter(Boolean).join("\n\n")
  }));
}

export function rawToolDeltaId(object: Record<string, unknown>): string {
  return firstString(object.toolCallId, object.toolExecutionId, object.tool_use_id, object.toolUseId, object.id);
}

function createToolGroup(key: string, id: string): InternalToolDeltaGroup {
  return {
    key,
    id,
    name: "",
    hasCommand: false,
    completed: false,
    parts: []
  };
}

type InternalToolDeltaGroup = {
  key: string;
  id: string;
  name: string;
  hasCommand: boolean;
  completed: boolean;
  parts: string[];
};

function toolGroupLabel(group: InternalToolDeltaGroup): string {
  if (group.completed && (group.name === "bash" || group.hasCommand)) {
    return "bash complete";
  }

  return group.name || "Tool call";
}

function isToolCompletion(object: Record<string, unknown>): boolean {
  const type = typeof object.type === "string" ? object.type : "";
  return type === "tool_execution_end" || type === "toolResult" || object.role === "toolResult";
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

function deltaHasCommand(object: Record<string, unknown>): boolean {
  const args = objectField(object.args) ?? objectField(object.input);
  return typeof args?.command === "string" || typeof object.command === "string";
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
